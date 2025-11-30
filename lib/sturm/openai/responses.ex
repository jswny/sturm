defmodule Sturm.OpenAI.Responses do
  @moduledoc """
  Thin client for the OpenAI Responses API used for Discord replies.
  """

  require Logger

  @endpoint "/v1/responses"

  def chat(messages, opts \\ []) do
    config = config()

    body =
      %{
        model: Keyword.get(opts, :model, config.model),
        input: messages,
        reasoning: Keyword.get(opts, :reasoning, config.reasoning),
        tools: tools(config, opts)
      }
      |> Enum.reject(fn {_k, v} -> is_nil(v) end)
      |> Map.new()

    req(config, opts)
    |> Req.post(url: @endpoint, json: body)
    |> normalize_response()
  end

  defp tools(config, opts) do
    case Keyword.get(opts, :tools, config.tools) do
      [] -> nil
      nil -> nil
      tools -> Enum.map(tools, &normalize_tool/1)
    end
  end

  defp req(config, opts) do
    timeout = Keyword.get(opts, :timeout_ms, config.timeout_ms)

    Req.new(
      base_url: config.base_url,
      auth: {:bearer, config.api_key},
      receive_timeout: timeout,
      connect_options: [transport_opts: [cacerts: :public_key.cacerts_get()]]
    )
  end

  defp normalize_response({:ok, %{status: status, body: body}}) when status in [200, 201] do
    {:ok, extract_output(body)}
  end

  defp normalize_response({:ok, %{status: 429, body: %{"error" => %{"message" => msg}} = body}}) do
    retry = Map.get(body, "retry_after") || Map.get(body, "error", %{}) |> Map.get("retry_after")
    {:error, {:rate_limited, retry, msg}}
  end

  defp normalize_response({:ok, %{status: status, body: body}}),
    do: {:error, {:http_error, status, body}}

  defp normalize_response({:error, reason}), do: {:error, reason}

  defp extract_output(%{"output" => outputs} = body) when is_list(outputs) do
    {text, images, binaries} =
      outputs
      |> Enum.reduce({nil, [], []}, fn item, {t_acc, url_acc, bin_acc} ->
        {
          t_acc || message_text(item),
          url_acc ++ message_images(item),
          bin_acc ++ message_image_binaries(item)
        }
      end)

    %{
      text: text || extract_top_level_text(body),
      images: images,
      image_binaries: binaries,
      raw: body
    }
  end

  defp extract_output(body) do
    %{
      text: extract_top_level_text(body),
      images: [],
      image_binaries: [],
      raw: body
    }
  end

  defp message_text(%{"type" => "message", "content" => content}), do: text_from_content(content)
  defp message_text(_), do: nil

  defp message_images(%{"type" => "message", "content" => content}),
    do: images_from_content(content)

  defp message_images(_), do: []

  defp message_image_binaries(%{"type" => "image_generation_call"} = item) do
    case item do
      %{"result" => data_b64, "output_format" => format} when is_binary(data_b64) ->
        [%{data_b64: data_b64, format: format}]

      _ ->
        []
    end
  end

  defp message_image_binaries(_), do: []

  defp images_from_content(nil), do: []

  defp images_from_content(content) when is_list(content) do
    content
    |> Enum.flat_map(fn
      %{"type" => "image_url", "image_url" => %{"url" => url}} when is_binary(url) -> [url]
      %{"type" => "image_url", "url" => url} when is_binary(url) -> [url]
      %{"type" => "image", "url" => url} when is_binary(url) -> [url]
      _ -> []
    end)
  end

  defp images_from_content(_), do: []

  defp extract_top_level_text(%{"output_text" => text})
       when is_binary(text) and byte_size(text) > 0,
       do: text

  defp extract_top_level_text(_), do: nil

  defp text_from_content(nil), do: nil

  defp text_from_content(content) when is_list(content) do
    content
    |> Enum.find_value(fn
      %{"type" => "output_text", "text" => text} when is_binary(text) and byte_size(text) > 0 ->
        text

      %{"type" => "text", "text" => text} when is_binary(text) and byte_size(text) > 0 ->
        text

      _ ->
        nil
    end)
  end

  defp text_from_content(_), do: nil

  defp config do
    config = Application.get_env(:sturm, :openai, [])

    %{
      api_key: Keyword.get(config, :api_key) || System.get_env("OPENAI_API_KEY"),
      base_url: Keyword.get(config, :base_url, "https://api.openai.com"),
      model: Keyword.get(config, :model, "gpt-5-mini"),
      reasoning: Keyword.get(config, :reasoning, %{effort: "low"}),
      tools: Keyword.get(config, :tools, []),
      timeout_ms: Keyword.get(config, :timeout_ms, 25_000)
    }
  end

  defp normalize_tool(%{} = tool), do: tool
  defp normalize_tool(type) when is_binary(type), do: %{"type" => type}
end
