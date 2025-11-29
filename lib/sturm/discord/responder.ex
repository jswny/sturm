defmodule Sturm.Discord.Responder do
  @moduledoc """
  Handles mention-triggered replies by sending context to OpenAI and posting the result.
  """

  require Logger

  alias Sturm.Discord.{ChannelBuffer, Rest}
  alias Sturm.OpenAI.Responses

  def respond(message, %{token: token, bot_id: bot_id, shard: shard}, history \\ nil) do
    channel_id = message["channel_id"]
    message_id = message["id"]
    history = history || ChannelBuffer.fetch(channel_id)

    with true <- should_reply?(history, bot_id),
         :ok <- maybe_typing(token, channel_id),
         {:ok, content} <- generate_reply(history, shard),
         :ok <- post_reply(token, channel_id, content, bot_id, reply_to: message_id) do
      :ok
    else
      false ->
        :ok

      {:error, reason} ->
        Logger.warning("Responder failed channel=#{channel_id}: #{inspect(reason)}")
        :ok
    end
  end

  defp generate_reply(history, shard) do
    payload = build_messages(history)

    Logger.debug("Responder sending to OpenAI shard=#{inspect(shard)}")

    case Responses.chat(payload) do
      {:ok, content} ->
        {:ok, content}

      {:error, {:empty_output, _body}} ->
        Logger.debug("Responder retrying with fallback model")

        Responses.chat(payload, model: fallback_model(), reasoning: nil)
        |> case do
          {:ok, content} -> {:ok, content}
          other -> other
        end

      other ->
        other
    end
  end

  defp build_messages(history) do
    system_prompt =
      Application.get_env(:sturm, :openai, [])
      |> Keyword.get(:system_prompt)
      |> presence("")

    [%{role: "system", content: system_prompt}] ++
      Enum.map(history, fn item ->
        %{
          role: item.role,
          content: prefix_content(item)
        }
      end)
  end

  defp post_reply(token, channel_id, content, bot_id, opts) do
    clean = strip_assistant_prefix(content)

    case Rest.create_message(token, channel_id, clean, opts) do
      {:ok, body} ->
        message_id = Map.get(body, "id", "")
        append_assistant(channel_id, bot_id, clean, message_id)
        :ok

      :ok ->
        append_assistant(channel_id, bot_id, clean, "")
        :ok

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp should_reply?(history, bot_id) do
    payload =
      history
      |> limit_history(judge_context_limit())
      |> judge_messages(bot_id)

    case Responses.chat(payload, model: judge_model(), reasoning: nil) do
      {:ok, text} ->
        judge_positive?(text)

      {:error, reason} ->
        Logger.debug("Responder judge skipped: #{inspect(reason)}")
        false
    end
  end

  defp judge_messages(history, bot_id) do
    base = [%{role: "system", content: judge_prompt()}]

    mention_hint =
      if bot_id do
        %{
          role: "system",
          content: "Bot user id: #{bot_id}. Mentions may appear as <@#{bot_id}> or <@!#{bot_id}>."
        }
      else
        nil
      end

    history_messages =
      Enum.map(history, fn item ->
        %{role: item.role, content: prefix_content(item)}
      end)

    base
    |> maybe_prepend_hint(mention_hint)
    |> Kernel.++(history_messages)
  end

  defp limit_history(history, limit) when is_list(history) and is_integer(limit) and limit > 0 do
    count = length(history)

    if count <= limit do
      history
    else
      Enum.slice(history, count - limit, limit)
    end
  end

  defp maybe_prepend_hint(messages, nil), do: messages
  defp maybe_prepend_hint(messages, hint), do: [hint | messages]

  defp judge_positive?(text) do
    text
    |> String.trim()
    |> String.upcase()
    |> String.starts_with?("YES")
  end

  defp judge_prompt do
    Application.get_env(:sturm, :openai, [])
    |> Keyword.get(:judge_prompt)
    |> presence("")
  end

  defp judge_model do
    Application.get_env(:sturm, :openai, [])
    |> Keyword.get(:judge_model, "gpt-4o-mini")
  end

  defp fallback_model do
    Application.get_env(:sturm, :openai, [])
    |> Keyword.get(:fallback_model, "gpt-4o-mini")
  end

  defp judge_context_limit do
    Application.get_env(:sturm, :discord, [])
    |> Keyword.get(:judge_context_limit, 20)
  end

  defp maybe_typing(token, channel_id) do
    case Rest.trigger_typing(token, channel_id) do
      :ok -> :ok
      {:ok, _} -> :ok
      {:error, _reason} -> :ok
    end
  end

  defp append_assistant(channel_id, bot_id, content, message_id) do
    ChannelBuffer.append(channel_id, %{
      role: "assistant",
      author_id: bot_id || "assistant",
      author_name: "sturmbot",
      content: content,
      message_id: message_id,
      timestamp: DateTime.utc_now() |> DateTime.to_iso8601(),
      channel_id: channel_id
    })
  end

  defp presence(nil, fallback), do: fallback
  defp presence(<<>>, fallback), do: fallback
  defp presence(value, _fallback), do: value

  defp prefix_content(item) do
    prefix =
      case item.role do
        "assistant" -> "[assistant #{item.author_name || "assistant"}] "
        _ -> "[user #{item.author_name || "user"}] "
      end

    prefix <> String.trim_leading(item.content || "")
  end

  defp strip_assistant_prefix(content) do
    content
    |> String.replace(~r/^\s*\[assistant[^\]]*\]\s*/i, "")
    |> String.trim_leading()
  end
end
