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
        reasoning: Keyword.get(opts, :reasoning, config.reasoning)
      }
      |> Enum.reject(fn {_k, v} -> is_nil(v) end)
      |> Map.new()

    req(config)
    |> Req.post(url: @endpoint, json: body)
    |> normalize_response()
  end

  defp req(config) do
    Req.new(
      base_url: config.base_url,
      auth: {:bearer, config.api_key},
      receive_timeout: config.timeout_ms,
      connect_options: [transport_opts: [cacerts: :public_key.cacerts_get()]]
    )
  end

  defp normalize_response({:ok, %{status: status, body: body}}) when status in [200, 201] do
    case extract_text(body) do
      nil -> {:error, {:empty_output, body}}
      text -> {:ok, text}
    end
  end

  defp normalize_response({:ok, %{status: 429, body: %{"error" => %{"message" => msg}} = body}}) do
    retry = Map.get(body, "retry_after") || Map.get(body, "error", %{}) |> Map.get("retry_after")
    {:error, {:rate_limited, retry, msg}}
  end

  defp normalize_response({:ok, %{status: status, body: body}}),
    do: {:error, {:http_error, status, body}}

  defp normalize_response({:error, reason}), do: {:error, reason}

  defp extract_text(%{"output" => outputs} = body) when is_list(outputs) do
    outputs
    |> Enum.find_value(&message_text/1)
    |> case do
      nil -> extract_top_level_text(body)
      text -> text
    end
  end

  defp extract_text(body), do: extract_top_level_text(body)

  defp message_text(%{"type" => "message", "content" => content}), do: text_from_content(content)
  defp message_text(_), do: nil

  defp extract_top_level_text(%{"output_text" => text}) when is_binary(text) and byte_size(text) > 0,
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
      timeout_ms: Keyword.get(config, :timeout_ms, 25_000)
    }
  end
end
