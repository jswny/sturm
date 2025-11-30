defmodule Sturm.Discord.Shard do
  @moduledoc """
  A lightweight Discord gateway shard built on Mint.WebSocket.
  """

  use GenServer
  require Logger

  alias Sturm.Discord.{ChannelBuffer, Responder}

  @gateway_params "v=10&encoding=json"
  @identify_op 2
  @heartbeat_op 1
  @hello_op 10
  @heartbeat_ack_op 11
  @invalid_session_op 9
  @dispatch_op 0

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  @impl true
  def init(%{token: token, intents: intents, shard: shard, url: url}) do
    state = %{
      token: token,
      intents: intents,
      shard: shard,
      url: url,
      conn: nil,
      ref: nil,
      socket: nil,
      seq: nil,
      session_id: nil,
      bot_id: nil,
      status: nil,
      resp_headers: nil,
      pending_data: [],
      heartbeat_interval: nil,
      heartbeat_timer: nil,
      awaiting_ack?: false
    }

    {:ok, state, {:continue, :connect}}
  end

  @impl true
  def handle_continue(:connect, state) do
    case open_socket(state.url) do
      {:ok, conn, ref} ->
        {:noreply, %{state | conn: conn, ref: ref}}

      {:error, reason} ->
        Logger.error("Discord shard connect failed #{inspect(state.shard)}: #{inspect(reason)}")
        Process.send_after(self(), :retry_connect, 5_000)
        {:noreply, state}
    end
  end

  @impl true
  def handle_info(:retry_connect, state), do: handle_continue(:connect, state)

  def handle_info({transport, _socket, _data} = msg, %{conn: conn} = state)
      when transport in [:tcp, :ssl] do
    case Mint.WebSocket.stream(conn, msg) do
      {:ok, conn, responses} ->
        handle_responses(responses, %{state | conn: conn})

      {:error, conn, reason, _responses} ->
        Logger.warning("Discord shard stream error #{inspect(reason)}")
        {:noreply, drop_and_retry(%{state | conn: conn})}

      :unknown ->
        Logger.debug("Discord shard #{inspect(state.shard)} ignored message #{inspect(msg)}")
        {:noreply, state}
    end
  end

  def handle_info(:send_heartbeat, state) do
    if state.awaiting_ack? do
      Logger.warning("Discord shard missed heartbeat ACK, reconnecting")
      {:noreply, drop_and_retry(state)}
    else
      {:noreply, sent_state} = send_frame({:text, heartbeat_payload(state.seq)}, state)
      timer = schedule_heartbeat(sent_state.heartbeat_interval)
      {:noreply, %{sent_state | awaiting_ack?: true, heartbeat_timer: timer}}
    end
  end

  def handle_info(msg, state) do
    Logger.debug("Discord shard #{inspect(state.shard)} unexpected message #{inspect(msg)}")
    {:noreply, state}
  end

  # Internal response handling

  defp handle_responses(responses, state) do
    Enum.reduce_while(responses, {:noreply, state}, fn
      {:status, ref, status}, {:noreply, st} when ref == st.ref ->
        {:cont, {:noreply, %{st | status: status}}}

      {:headers, ref, headers}, {:noreply, st} when ref == st.ref ->
        {:cont, {:noreply, %{st | resp_headers: headers}}}

      {:done, ref}, {:noreply, st} when ref == st.ref ->
        case Mint.WebSocket.new(st.conn, ref, st.status, st.resp_headers || []) do
          {:ok, conn, socket} ->
            Logger.info("Discord shard #{inspect(st.shard)} upgraded to WebSocket (#{st.status})")
            st = %{st | conn: conn, socket: socket}

            # If any websocket data arrived before the upgrade completed, process it now.
            st =
              case st.pending_data do
                [] ->
                  st

                pending ->
                  data = IO.iodata_to_binary(Enum.reverse(pending))

                  case Mint.WebSocket.decode(st.socket, data) do
                    {:ok, socket, frames} ->
                      st = %{st | socket: socket, pending_data: []}
                      handle_frames(frames, st) |> elem(1)

                    {:error, reason} ->
                      Logger.error(
                        "Discord shard frame decode error post-upgrade: #{inspect(reason)}"
                      )

                      st
                  end
              end

            {:cont, {:noreply, st}}

          {:error, reason} ->
            Logger.error("Discord shard failed WebSocket upgrade: #{inspect(reason)}")
            {:halt, {:noreply, drop_and_retry(st)}}
        end

      {:data, ref, data}, {:noreply, st} when ref == st.ref and st.socket != nil ->
        case Mint.WebSocket.decode(st.socket, data) do
          {:ok, socket, frames} ->
            st = %{st | socket: socket}
            {:cont, handle_frames(frames, st)}

          {:error, reason} ->
            Logger.error("Discord shard frame decode error: #{inspect(reason)}")
            {:halt, {:noreply, drop_and_retry(st)}}
        end

      {:data, ref, data}, {:noreply, st} when ref == st.ref ->
        # Buffer data that arrives before the websocket upgrade finishes.
        {:cont, {:noreply, %{st | pending_data: [data | st.pending_data]}}}

      _other, acc ->
        {:cont, acc}
    end)
  end

  defp handle_frames(frames, state) do
    Enum.reduce(frames, {:noreply, state}, fn
      {:text, payload}, {:noreply, st} ->
        with {:ok, map} <- Jason.decode(payload) do
          handle_payload(map, st)
        else
          {:error, reason} ->
            Logger.warning(
              "Discord shard #{inspect(st.shard)} failed to decode frame: #{inspect(reason)}"
            )

            {:noreply, st}

          _ ->
            {:noreply, st}
        end

      {:ping, data}, {:noreply, st} ->
        Logger.debug("Discord shard #{inspect(st.shard)} received ping")
        {:noreply, send_frame({:pong, data}, st) |> elem(1)}

      {:pong, _data}, acc ->
        # We don't currently track RTT; just continue
        acc

      {:close, code, reason}, {:noreply, st} ->
        Logger.warning(
          "Discord shard #{inspect(st.shard)} received close code=#{inspect(code)} reason=#{inspect(reason)}"
        )

        {:noreply, drop_and_retry(st)}

      other, acc ->
        Logger.debug("Discord shard #{inspect(state.shard)} ignored frame #{inspect(other)}")
        acc
    end)
  end

  defp handle_payload(%{"op" => @hello_op, "d" => %{"heartbeat_interval" => interval}}, state) do
    Logger.info("Discord shard #{inspect(state.shard)} HELLO (heartbeat #{interval}ms)")
    timer = schedule_heartbeat(interval)
    st = %{state | heartbeat_interval: interval, heartbeat_timer: timer, awaiting_ack?: false}
    send_frame({:text, identify_payload(st)}, st)
  end

  defp handle_payload(%{"op" => @heartbeat_ack_op}, state) do
    Logger.debug("Discord shard #{inspect(state.shard)} heartbeat ACK")
    {:noreply, %{state | awaiting_ack?: false}}
  end

  defp handle_payload(%{"op" => @dispatch_op, "t" => type, "s" => seq, "d" => data}, state) do
    state = %{state | seq: seq}

    case type do
      "MESSAGE_CREATE" ->
        handle_message_create(data, state)

      "READY" ->
        session_id = Map.get(data, "session_id")
        guilds = Map.get(data, "guilds", [])
        bot_id = get_in(data, ["user", "id"])

        Logger.info(
          "Discord READY shard #{inspect(state.shard)} session=#{session_id} guilds=#{length(guilds)} bot_id=#{bot_id}"
        )

        {:noreply, %{state | session_id: session_id, bot_id: bot_id}}

      "RESUMED" ->
        Logger.info("Discord RESUMED shard #{inspect(state.shard)}")
        {:noreply, state}

      other ->
        Logger.debug("Discord event #{other} shard #{inspect(state.shard)} seq=#{seq}")
        {:noreply, state}
    end
  end

  defp handle_payload(%{"op" => @invalid_session_op}, state) do
    Logger.warning("Discord shard received invalid session, reconnecting")
    {:noreply, drop_and_retry(state)}
  end

  defp handle_payload(_other, state), do: {:noreply, state}

  defp handle_message_create(data, state) do
    channel_id = data["channel_id"]
    author = data["author"] || %{}
    author_id = author["id"] || "unknown"
    author_name = author["username"] || author_id
    content = message_content(data)
    is_bot? = author["bot"] || author_id == state.bot_id

    buffer_item = %{
      role: if(author_id == state.bot_id, do: "assistant", else: "user"),
      author_id: author_id,
      author_name: sanitize_name(author_name),
      content: content,
      message_id: data["id"] || "",
      timestamp: data["timestamp"] || DateTime.utc_now() |> DateTime.to_iso8601(),
      channel_id: channel_id
    }

    # Append synchronously to preserve order, then snapshot history for this message
    :ok = ChannelBuffer.append(channel_id, buffer_item)

    if not is_bot? do
      history = ChannelBuffer.fetch(channel_id)

      Task.start(fn ->
        Responder.respond(data, %{token: state.token, bot_id: state.bot_id, shard: state.shard}, history)
      end)
    end

    {:noreply, state}
  end

  defp message_content(%{"content" => content})
       when is_binary(content) and byte_size(content) > 0,
       do: content

  defp message_content(%{"attachments" => attachments})
       when is_list(attachments) and attachments != [] do
    summary =
      attachments
      |> Enum.map(fn att -> att["filename"] || att["url"] || "attachment" end)
      |> Enum.join(", ")

    "[attachments: #{summary}]"
  end

  defp message_content(_), do: ""

  defp sanitize_name(nil), do: "user"

  defp sanitize_name(name) do
    name
    |> String.downcase()
    |> String.replace(~r/[^a-z0-9_\-]/, "_")
    |> String.slice(0, 30)
    |> case do
      "" -> "user"
      cleaned -> cleaned
    end
  end

  defp open_socket(gateway_url) do
    uri = URI.parse(gateway_url)
    host = uri.host || "gateway.discord.gg"
    path = "#{uri.path || "/"}?#{@gateway_params}"
    scheme = uri.scheme || "wss"
    port = uri.port || 443

    with {:ok, conn} <-
           Mint.HTTP.connect(scheme_atom(scheme), host, port,
             protocols: [:http1],
             transport_opts: [cacerts: :public_key.cacerts_get()]
           ),
         {:ok, conn, ref} <-
           Mint.WebSocket.upgrade(upgrade_scheme(scheme), conn, path, [{"host", host}]) do
      {:ok, conn, ref}
    else
      {:error, _conn, reason} -> {:error, reason}
      {:error, reason} -> {:error, reason}
    end
  end

  defp send_frame(frame, %{socket: socket, conn: conn, ref: ref} = state) do
    {:ok, socket, data} = Mint.WebSocket.encode(socket, frame)
    {:ok, conn} = Mint.WebSocket.stream_request_body(conn, ref, data)
    {:noreply, %{state | socket: socket, conn: conn}}
  end

  defp schedule_heartbeat(interval_ms) do
    Process.send_after(self(), :send_heartbeat, interval_ms)
  end

  defp drop_and_retry(state) do
    cancel_timer(state.heartbeat_timer)
    Process.send_after(self(), :retry_connect, 5_000)

    %{
      state
      | conn: nil,
        socket: nil,
        ref: nil,
        session_id: nil,
        status: nil,
        resp_headers: nil,
        pending_data: [],
        heartbeat_timer: nil,
        awaiting_ack?: false
    }
  end

  defp cancel_timer(nil), do: :ok
  defp cancel_timer(ref), do: Process.cancel_timer(ref)

  defp identify_payload(%{token: token, intents: intents, shard: {idx, total}}) do
    %{
      op: @identify_op,
      d: %{
        token: token,
        intents: intents,
        properties: %{
          "$os" => "elixir",
          "$browser" => "sturm",
          "$device" => "sturm"
        },
        compress: false,
        shard: [idx, total]
      }
    }
    |> Jason.encode!()
  end

  defp heartbeat_payload(seq) do
    %{op: @heartbeat_op, d: seq} |> Jason.encode!()
  end

  defp scheme_atom("wss"), do: :https
  defp scheme_atom("https"), do: :https
  defp scheme_atom("ws"), do: :http
  defp scheme_atom("http"), do: :http

  defp upgrade_scheme("wss"), do: :wss
  defp upgrade_scheme("https"), do: :wss
  defp upgrade_scheme("ws"), do: :ws
  defp upgrade_scheme("http"), do: :ws
end
