defmodule Sturm.Discord.BotIdentity do
  @moduledoc """
  Provides a per-guild bot display label, preferring the guild nickname and
  falling back to the bot username. Results are cached in-memory.
  """

  use Agent

  alias Sturm.Discord.Rest

  def start_link(_opts \\ []) do
    Agent.start_link(fn -> %{} end, name: __MODULE__)
  end

  @doc """
  Returns the bot label for the given guild (nickname preferred, else username).
  """
  def label(nil, _bot_id, _token), do: {:error, :missing_guild}
  def label(_guild_id, nil, _token), do: {:error, :missing_bot_id}

  def label(guild_id, bot_id, token) do
    case Agent.get(__MODULE__, &Map.get(&1, guild_id)) do
      nil -> fetch_and_cache(guild_id, bot_id, token)
      label -> {:ok, label}
    end
  end

  defp fetch_and_cache(guild_id, bot_id, token) do
    with {:ok, body} <- Rest.bot_member(token, guild_id, bot_id),
         label when is_binary(label) <- label_from_member(body),
         true <- present?(label) do
      Agent.update(__MODULE__, &Map.put(&1, guild_id, label))
      {:ok, label}
    else
      {:error, reason} -> {:error, {:rest_error, reason}}
      other -> {:error, {:label_not_found, other}}
    end
  end

  defp label_from_member(%{"nick" => nick, "user" => %{"username" => username}}),
    do: preferred(nick, username)

  defp label_from_member(%{"user" => %{"username" => username}}), do: preferred(nil, username)
  defp label_from_member(_), do: nil

  defp preferred(nick, username) do
    cond do
      present?(nick) -> nick
      present?(username) -> username
      true -> nil
    end
  end

  defp present?(nil), do: false
  defp present?(val) when is_binary(val), do: String.trim(val) != ""
  defp present?(_), do: false
end
