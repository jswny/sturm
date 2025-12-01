defmodule Sturm.Discord.ChannelAccess do
  @moduledoc """
  Caches enabled Discord channels and provides enable/disable operations.
  Default state is disabled unless a channel is explicitly enabled.
  """

  use GenServer
  require Logger

  alias Sturm.Repo
  alias Sturm.Discord.{ChannelBuffer, ChannelSettings}
  import Ecto.Query

  # Public API

  def start_link(_opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  def enabled?(channel_id) when is_binary(channel_id) do
    GenServer.call(__MODULE__, {:enabled?, channel_id})
  end

  def enable!(guild_id, channel_id) when is_binary(guild_id) and is_binary(channel_id) do
    GenServer.call(__MODULE__, {:enable, guild_id, channel_id})
  end

  def disable!(guild_id, channel_id) when is_binary(guild_id) and is_binary(channel_id) do
    GenServer.call(__MODULE__, {:disable, guild_id, channel_id})
  end

  # Callbacks

  @impl true
  def init(:ok) do
    enabled_channels =
      ChannelSettings
      |> where([cs], cs.enabled == true)
      |> select([cs], cs.channel_id)
      |> Repo.all()
      |> MapSet.new()

    {:ok, %{enabled: enabled_channels}}
  end

  @impl true
  def handle_call({:enabled?, channel_id}, _from, state) do
    {:reply, MapSet.member?(state.enabled, channel_id), state}
  end

  def handle_call({:enable, guild_id, channel_id}, _from, state) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    attrs = %{guild_id: guild_id, channel_id: channel_id, enabled: true}

    case Repo.insert(
           ChannelSettings.changeset(%ChannelSettings{}, attrs),
           on_conflict: [set: [enabled: true, updated_at: now]],
           conflict_target: :channel_id
         ) do
      {:ok, _} ->
        new_state = put_in(state.enabled, MapSet.put(state.enabled, channel_id))
        {:reply, :ok, new_state}

      {:error, reason} ->
        Logger.warning("ChannelAccess enable failed channel=#{channel_id}: #{inspect(reason)}")
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:disable, guild_id, channel_id}, _from, state) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    attrs = %{guild_id: guild_id, channel_id: channel_id, enabled: false}

    result =
      Repo.insert(
        ChannelSettings.changeset(%ChannelSettings{}, attrs),
        on_conflict: [set: [enabled: false, updated_at: now]],
        conflict_target: :channel_id
      )

    case result do
      {:ok, _} ->
        # Clear any buffered context for disabled channels.
        _ = safe_reset_buffer(channel_id)
        new_state = put_in(state.enabled, MapSet.delete(state.enabled, channel_id))
        {:reply, :ok, new_state}

      {:error, reason} ->
        Logger.warning("ChannelAccess disable failed channel=#{channel_id}: #{inspect(reason)}")
        {:reply, {:error, reason}, state}
    end
  end

  # Helpers

  defp safe_reset_buffer(channel_id) do
    ChannelBuffer.reset(channel_id)
  catch
    kind, reason ->
      Logger.debug(
        "ChannelAccess buffer reset failed channel=#{channel_id} kind=#{inspect(kind)} reason=#{inspect(reason)}"
      )

      :ok
  end
end
