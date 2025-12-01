defmodule Sturm.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application
  require Logger

  @impl true
  def start(_type, _args) do
    children =
      [
        SturmWeb.Telemetry,
        Sturm.Repo,
        {DNSCluster, query: Application.get_env(:sturm, :dns_cluster_query) || :ignore},
        {Phoenix.PubSub, name: Sturm.PubSub}
      ] ++
        discord_children() ++
        [
          # Start to serve requests, typically the last entry
          SturmWeb.Endpoint
        ]

    # See https://hexdocs.pm/elixir/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: Sturm.Supervisor]
    Supervisor.start_link(children, opts)
  end

  defp discord_children do
    case Application.get_env(:sturm, :discord) do
      config when is_list(config) ->
        token = Keyword.get(config, :token, "")

        cond do
          is_binary(token) and byte_size(token) > 0 ->
            [
              Sturm.Discord.BotIdentity,
              Sturm.Discord.Supervisor
            ]

          true ->
            Logger.warning("Discord bot not started: missing token")
            []
        end

      _ ->
        Logger.warning("Discord bot not started: :discord config not set")
        []
    end
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    SturmWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
