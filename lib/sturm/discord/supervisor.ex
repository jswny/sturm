defmodule Sturm.Discord.Supervisor do
  @moduledoc """
  Entry point for the Discord namespace. Starts shard processes alongside the web tree.
  """

  use Supervisor
  require Logger

  alias Sturm.Discord.{BufferSupervisor, ChannelAccess, Rest, Shard}

  def start_link(init_arg), do: Supervisor.start_link(__MODULE__, init_arg, name: __MODULE__)

  @impl true
  def init(_arg) do
    with {:ok, config} <- discord_config(),
         {:ok, gateway_info} <- Rest.gateway_bot(config.token) do
      shard_total = gateway_info["shards"] || 1
      url = gateway_info["url"]

      shard_children =
        for shard_index <- 0..(shard_total - 1) do
          Supervisor.child_spec(
            {Shard,
             %{
               token: config.token,
               intents: config.intents,
               shard: {shard_index, shard_total},
               url: url
             }},
            id: {:discord_shard, shard_index}
          )
        end

      children =
        [
          {Registry, keys: :unique, name: Sturm.Discord.BufferRegistry},
          BufferSupervisor,
          ChannelAccess
        ] ++ shard_children

      Supervisor.init(children, strategy: :one_for_one)
    else
      {:error, reason} ->
        Logger.error("Discord supervisor aborted: #{inspect(reason)}")
        # Fail the supervisor start so the app doesn't silently run without Discord
        {:stop, reason}
    end
  end

  defp discord_config do
    with {:ok, token} <- fetch_env(:token) do
      intents = Application.get_env(:sturm, :discord) |> Keyword.get(:intents, 513)
      {:ok, %{token: token, intents: intents}}
    end
  end

  defp fetch_env(key) do
    case Application.fetch_env(:sturm, :discord) do
      :error -> {:error, :missing_discord_config}
      {:ok, kw} -> Keyword.fetch(kw, key)
    end
  end
end
