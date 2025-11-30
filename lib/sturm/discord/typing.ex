defmodule Sturm.Discord.Typing do
  @moduledoc """
  Keeps Discord typing indicators alive by periodically triggering the typing endpoint.
  """

  alias Sturm.Discord.Rest

  @default_interval_ms 8_000

  @doc """
  Starts a background loop that sends typing for the given channel.

  Returns the pid so callers can stop it via `stop/1`.
  """
  def start(token, channel_id, interval_ms \\ @default_interval_ms) do
    spawn(fn -> loop(token, channel_id, interval_ms) end)
  end

  @doc """
  Stops a running typing loop.
  """
  def stop(nil), do: :ok

  def stop(pid) when is_pid(pid) do
    send(pid, :stop_typing)
    :ok
  end

  # Internal loop; purposely unlinked from callers so failures don't crash them.
  defp loop(token, channel_id, interval_ms) do
    _ = Rest.trigger_typing(token, channel_id)

    receive do
      :stop_typing ->
        :ok
    after
      interval_ms ->
        loop(token, channel_id, interval_ms)
    end
  end
end
