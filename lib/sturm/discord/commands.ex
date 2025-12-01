defmodule Sturm.Discord.Commands do
  @moduledoc """
  Handles application command interactions and command registration.
  """

  import Bitwise
  require Logger
  alias Sturm.Discord.{ChannelAccess, Rest}

  @ephemeral_flag 1 <<< 6

  def register_guild_commands(token, application_id, guild_id)
      when is_binary(token) and is_binary(application_id) and is_binary(guild_id) do
    case Rest.put_guild_commands(token, application_id, guild_id, command_definitions()) do
      {:ok, _} ->
        Logger.debug("Registered commands for guild=#{guild_id}")
        :ok

      {:error, reason} ->
        Logger.warning("Failed to register commands for guild=#{guild_id}: #{inspect(reason)}")
        {:error, reason}
    end
  end

  def handle_interaction(%{"type" => 2} = interaction, %{token: token})
      when is_binary(token) do
    name = interaction |> get_in(["data", "name"]) |> normalize_name()
    channel_id = interaction["channel_id"]
    guild_id = interaction["guild_id"]

    cond do
      is_nil(channel_id) ->
        reply(interaction, token, "This command must be used in a channel or thread.")

      is_nil(guild_id) ->
        reply(interaction, token, "Guild information is missing; cannot apply settings.")

      name == "enable" ->
        enable(channel_id, guild_id, interaction, token)

      name == "disable" ->
        disable(channel_id, guild_id, interaction, token)

      true ->
        reply(interaction, token, "Unknown command.")
    end
  end

  def handle_interaction(_other, _ctx), do: :noop

  # Internals

  defp enable(channel_id, guild_id, interaction, token) do
    case ChannelAccess.enable!(guild_id, channel_id) do
      :ok ->
        reply(interaction, token, "Autobot enabled in this channel.")

      {:error, reason} ->
        Logger.warning("Enable command failed channel=#{channel_id}: #{inspect(reason)}")
        reply(interaction, token, "Autobot failed to enable in this channel.")
    end
  end

  defp disable(channel_id, guild_id, interaction, token) do
    case ChannelAccess.disable!(guild_id, channel_id) do
      :ok ->
        reply(interaction, token, "Autobot disabled in this channel.")

      {:error, reason} ->
        Logger.warning("Disable command failed channel=#{channel_id}: #{inspect(reason)}")
        reply(interaction, token, "Autobot failed to disable in this channel.")
    end
  end

  defp reply(interaction, token, message) when is_binary(message) do
    Rest.create_interaction_response(interaction, token, %{
      type: 4,
      data: %{content: message, flags: @ephemeral_flag}
    })
  end

  defp command_definitions do
    [
      %{
        name: "enable",
        description: "Enable the bot in this channel or thread",
        type: 1
      },
      %{
        name: "disable",
        description: "Disable the bot in this channel or thread",
        type: 1
      }
    ]
  end

  defp normalize_name(nil), do: nil
  defp normalize_name(name) when is_binary(name), do: String.downcase(name)
end
