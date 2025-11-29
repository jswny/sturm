defmodule Sturm.Discord.Rest do
  @moduledoc """
  Minimal REST helper for Discord HTTP endpoints used during gateway setup and bot messaging.
  """

  @api_base "https://discord.com/api/v10"

  def gateway_bot(token) do
    req()
    |> Req.get(url: "#{@api_base}/gateway/bot", headers: auth(token))
    |> normalize_response()
  end

  def trigger_typing(token, channel_id) do
    req()
    |> Req.post(url: "#{@api_base}/channels/#{channel_id}/typing", headers: auth(token))
    |> normalize_response()
  end

  def create_message(token, channel_id, content) do
    req()
    |> Req.post(
      url: "#{@api_base}/channels/#{channel_id}/messages",
      headers: auth(token),
      json: %{content: content}
    )
    |> normalize_response()
  end

  defp auth(token), do: [{"authorization", "Bot #{token}"}]

  defp req do
    Req.new(
      max_redirects: 3,
      connect_options: [transport_opts: [cacerts: :public_key.cacerts_get()]]
    )
  end

  defp normalize_response({:ok, %{status: status, body: body}}) when status in [200, 201],
    do: {:ok, body}

  defp normalize_response({:ok, %{status: 204}}), do: :ok

  defp normalize_response({:ok, %{status: 429, body: %{"retry_after" => retry}}}),
    do: {:error, {:rate_limited, retry}}

  defp normalize_response({:ok, %{status: status, body: body}}),
    do: {:error, {:http_error, status, body}}

  defp normalize_response({:error, reason}), do: {:error, reason}
end
