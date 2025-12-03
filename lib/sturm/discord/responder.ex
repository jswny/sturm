defmodule Sturm.Discord.Responder do
  @moduledoc """
  Handles mention-triggered replies by sending context to OpenAI and posting the result.
  """

  require Logger

  alias Sturm.Discord.{BotIdentity, ChannelBuffer, Rest, Typing}
  alias Sturm.OpenAI.Responses

  def respond(message, %{token: token, bot_id: bot_id, shard: shard}, history \\ nil) do
    channel_id = message["channel_id"]
    message_id = message["id"]
    guild_id = message["guild_id"]
    history = history || ChannelBuffer.fetch(channel_id)

    bot_label =
      case BotIdentity.label(guild_id, bot_id, token) do
        {:ok, label} when is_binary(label) -> label
        {:error, reason} -> raise "Bot label unavailable: #{inspect(reason)}"
      end

    case should_reply?(message, history, bot_id, channel_id, message_id, bot_label) do
      true ->
        typing_ref = Typing.start(token, channel_id)

        result =
          try do
            with {:ok, reply} <-
                   generate_reply(history, shard, channel_id, message_id, bot_label),
                 :ok <-
                   post_reply(token, channel_id, reply, bot_id, bot_label, reply_to: message_id) do
              :ok
            end
          after
            Typing.stop(typing_ref)
          end

        case result do
          :ok ->
            :ok

          {:error, {:openai, reason}} ->
            Logger.warning("Responder failed (openai) channel=#{channel_id}: #{inspect(reason)}")
            :ok

          {:error, {:discord, reason}} ->
            Logger.warning("Responder failed (discord) channel=#{channel_id}: #{inspect(reason)}")
            :ok

          {:error, reason} ->
            Logger.warning("Responder failed channel=#{channel_id}: #{inspect(reason)}")
            :ok
        end

      false ->
        :ok
    end
  end

  defp generate_reply(history, shard, channel_id, message_id, bot_label) do
    payload = build_messages(history, bot_label)

    Logger.debug(
      "Responder generating reply shard=#{inspect(shard)} channel=#{channel_id} message_id=#{message_id}"
    )

    case Responses.chat(payload) do
      {:ok, reply} ->
        {:ok, reply}

      {:error, reason} ->
        Logger.warning("Responder OpenAI error: #{inspect(reason)}")
        {:error, {:openai, reason}}
    end
  end

  defp build_messages(history, bot_label) do
    system_prompt = formatted_system_prompt(bot_label)

    [%{role: "system", content: system_prompt}] ++
      Enum.map(history, fn item ->
        %{
          role: item.role,
          content: prefix_content(item)
        }
      end)
  end

  defp post_reply(
         token,
         channel_id,
         reply = %{text: text, images: images, image_binaries: binaries},
         bot_id,
         bot_label,
         opts
       ) do
    attachments = build_attachments_from_binaries(binaries)

    clean =
      text
      |> strip_assistant_prefix()
      |> fallback_image_text(attachments, images)

    if attachments == [] and not present?(clean) do
      raw =
        case reply do
          %{} = r -> Map.get(r, :raw) || Map.get(r, "raw")
          _ -> nil
        end

      Logger.warning(
        "Responder produced empty reply, skipping send channel=#{channel_id} payload=#{inspect(%{text: text, images: images, raw: raw})}"
      )

      :ok
    else
      opts = maybe_put_attachments(opts, attachments)

      case Rest.create_message(token, channel_id, clean, opts) do
        {:ok, body} ->
          message_id = Map.get(body, "id", "")
          buffer_content = buffer_content(clean, attachments)
          append_assistant(channel_id, bot_id, bot_label, buffer_content, message_id)
          :ok

        :ok ->
          buffer_content = buffer_content(clean, attachments)
          append_assistant(channel_id, bot_id, bot_label, buffer_content, "")
          :ok

        {:error, reason} ->
          {:error, {:discord, reason}}
      end
    end
  end

  defp should_reply?(message, history, bot_id, channel_id, message_id, bot_label) do
    if explicit_direct?(message, bot_id) do
      Logger.debug(
        "Judge bypass: explicit mention detected channel=#{channel_id} message_id=#{message_id}"
      )

      true
    else
      payload =
        history
        |> limit_history(judge_context_limit())
        |> judge_messages(bot_id, bot_label)

      case Responses.chat(payload,
             model: judge_model(),
             reasoning: nil,
             tools: [],
             timeout_ms: judge_timeout_ms()
           ) do
        {:ok, %{text: text}} when is_binary(text) ->
          decision = judge_positive?(text)

          Logger.debug(
            "Judge decision=#{decision} channel=#{channel_id} message_id=#{message_id} bot_label=#{inspect(bot_label)} judge_text=#{inspect(text)}"
          )

          decision

        {:ok, _} ->
          false

        {:error, reason} ->
          Logger.debug("Responder judge skipped: #{inspect(reason)}")
          false
      end
    end
  end

  defp explicit_direct?(message, bot_id),
    do: bot_id && mentioned_in_payload?(message, bot_id)

  defp mentioned_in_payload?(%{"mentions" => mentions}, bot_id) when is_list(mentions) do
    Enum.any?(mentions, fn
      %{"id" => id} when id == bot_id -> true
      _ -> false
    end)
  end

  defp mentioned_in_payload?(_, _), do: false

  defp judge_messages(history, bot_id, bot_label) do
    base = [%{role: "system", content: judge_prompt(bot_label)}]

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

  defp judge_positive?(text) when is_binary(text) do
    text
    |> String.trim()
    |> String.upcase()
    |> String.starts_with?("YES")
  end

  defp judge_positive?(_), do: false

  defp judge_prompt(bot_label) do
    Application.get_env(:sturm, :openai, [])
    |> Keyword.get(:judge_prompt)
    |> presence("")
    |> eval_template(bot_label)
  end

  defp judge_model do
    Application.get_env(:sturm, :openai, [])
    |> Keyword.get(:judge_model)
  end

  defp judge_timeout_ms do
    Application.get_env(:sturm, :openai, [])
    |> Keyword.get(:judge_timeout_ms, 30_000)
  end

  defp judge_context_limit do
    Application.get_env(:sturm, :discord, [])
    |> Keyword.get(:judge_context_limit, 20)
  end

  defp formatted_system_prompt(bot_label) do
    config = Application.get_env(:sturm, :openai, [])

    combined =
      build_prompt(
        Keyword.get(config, :responder_prompt_core),
        Keyword.get(config, :responder_prompt_style),
        Keyword.get(config, :system_prompt)
      )

    combined
    |> presence("")
    |> eval_template(bot_label)
  end

  defp build_prompt(core, style, legacy) do
    core = presence(core, "")
    style = presence(style, "")

    cond do
      core != "" and style != "" -> core <> "\n" <> style
      core != "" -> core
      style != "" -> style
      true -> presence(legacy, "")
    end
  end

  defp eval_template(prompt, bot_label) when is_binary(prompt) do
    EEx.eval_string(prompt, bot_name: bot_label)
  end

  defp eval_template(_, _), do: ""

  defp append_assistant(channel_id, bot_id, bot_label, content, message_id) do
    ChannelBuffer.append(channel_id, %{
      role: "assistant",
      author_id: bot_id || "assistant",
      author_name: bot_label,
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
    (content || "")
    |> String.replace(~r/^\s*\[assistant[^\]]*\]\s*/i, "")
    |> String.trim_leading()
  end

  defp maybe_put_attachments(opts, []), do: opts

  defp maybe_put_attachments(opts, attachments),
    do: Keyword.put(opts, :attachments, attachments)

  defp fallback_image_text(text, [], image_urls) do
    cond do
      present?(text) -> text
      present?(hd_or_nil(image_urls)) -> hd_or_nil(image_urls)
      true -> ""
    end
  end

  defp fallback_image_text(nil, _attachments, _images), do: ""
  defp fallback_image_text("", _attachments, _images), do: ""
  defp fallback_image_text(text, _attachments, _images), do: text

  defp buffer_content(text, []), do: text

  defp buffer_content(text, _attachments) when text in [nil, ""] do
    "[image]"
  end

  defp buffer_content(text, _attachments), do: text

  defp build_attachments_from_binaries(binaries) when is_list(binaries) do
    binaries
    |> Enum.with_index()
    |> Enum.map(fn {%{data_b64: data_b64, format: format}, idx} ->
      %{
        data: Base.decode64!(data_b64),
        filename: "image-#{idx}.#{extension(format)}",
        content_type: content_type(format)
      }
    end)
  end

  defp extension("png"), do: "png"
  defp extension("jpeg"), do: "jpg"
  defp extension("jpg"), do: "jpg"
  defp extension("webp"), do: "webp"
  defp extension(_), do: "png"

  defp content_type("png"), do: "image/png"
  defp content_type("jpeg"), do: "image/jpeg"
  defp content_type("jpg"), do: "image/jpeg"
  defp content_type("webp"), do: "image/webp"
  defp content_type(_), do: "application/octet-stream"

  defp present?(val) when is_binary(val), do: String.trim(val) != ""
  defp present?(_), do: false

  defp hd_or_nil([]), do: nil
  defp hd_or_nil([h | _]), do: h
end
