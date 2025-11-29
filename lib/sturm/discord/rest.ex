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

  def create_message(token, channel_id, content, opts \\ []) do
    json =
      %{content: content}
      |> maybe_put_message_reference(opts, channel_id)
      |> maybe_put_allowed_mentions(opts)

    req()
    |> Req.post(
      url: "#{@api_base}/channels/#{channel_id}/messages",
      headers: auth(token),
      json: json
    )
    |> normalize_response()
  end

  defp maybe_put_message_reference(json, opts, channel_id) do
    case Keyword.get(opts, :reply_to) do
      nil -> json
      message_id -> Map.put(json, :message_reference, %{message_id: message_id, channel_id: channel_id})
    end
  end

  defp maybe_put_allowed_mentions(json, opts) do
    case Keyword.get(opts, :allowed_mentions) do
      nil -> Map.put_new(json, :allowed_mentions, %{replied_user: false})
      allowed -> Map.put(json, :allowed_mentions, allowed)
    end
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
