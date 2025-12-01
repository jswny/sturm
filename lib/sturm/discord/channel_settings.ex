defmodule Sturm.Discord.ChannelSettings do
  @moduledoc """
  Ecto schema for per-channel enablement of the Discord bot.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :id, autogenerate: true}
  schema "discord_channel_settings" do
    field :guild_id, :string
    field :channel_id, :string
    field :enabled, :boolean, default: true

    timestamps()
  end

  def changeset(struct, attrs) do
    struct
    |> cast(attrs, [:guild_id, :channel_id, :enabled])
    |> validate_required([:guild_id, :channel_id, :enabled])
    |> unique_constraint(:channel_id)
  end
end
