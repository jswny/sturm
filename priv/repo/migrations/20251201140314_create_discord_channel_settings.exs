defmodule Sturm.Repo.Migrations.CreateDiscordChannelSettings do
  use Ecto.Migration

  def change do
    create table(:discord_channel_settings) do
      add :guild_id, :string, null: false
      add :channel_id, :string, null: false
      add :enabled, :boolean, default: true, null: false

      timestamps()
    end

    create unique_index(:discord_channel_settings, [:channel_id])
    create index(:discord_channel_settings, [:guild_id])
  end
end
