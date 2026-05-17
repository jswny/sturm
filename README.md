# Sturm

A webhook-based Discord bot on Cloudflare Workers.

Discord sends interactions to `/discord`. The Worker verifies Discord request
signatures, handles `/c text:<message>`, and forwards the text into a
Cloudflare `AIChatAgent` Durable Object. Conversations persist per Discord
surface:

- Guild channels use `discord:guild:<guild_id>:channel:<channel_id>`.
- Bot DMs use `discord:dm:<user_id>`.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars` for local development:

```text
DISCORD_PUBLIC_KEY=
DISCORD_APPLICATION_ID=
DISCORD_TOKEN=
DISCORD_TEST_GUILD_ID=
DISCORD_COMMAND_SCOPE=
```

For production, set secrets in Cloudflare:

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
```

`DISCORD_TOKEN` and `DISCORD_APPLICATION_ID` are only needed locally for command
registration unless the Worker starts calling authenticated Discord bot API
routes.

## Commands

Register `/c`:

```bash
npm run discord:register
```

By default, this registers `/c` globally with Discord's `GUILD` and `BOT_DM`
interaction contexts, so the same command works in servers and bot DMs. It can
take a little time for the Discord client to show new or changed global
commands.

For fast guild-only iteration, set `DISCORD_TEST_GUILD_ID` and run:

```bash
npm run discord:register:guild
```

Guild-scoped commands are not available in DMs.

Run locally:

```bash
npm run dev
```

Deploy:

```bash
npm run deploy
```

Set the Discord Developer Portal Interactions Endpoint URL to:

```text
https://<worker-host>/discord
```

## Project Structure

```text
src/
  discord.ts  # Discord interaction verification, routing, and replies
  server.ts   # Worker entrypoint and persistent ChatAgent
```

## Notes

- The bot currently supports `/c text:<message>`.
- Responses are deferred immediately, then the original interaction response is
  edited after Workers AI finishes.
- The demo `getWeather` tool still returns random weather data.
- The `calculate` tool runs server-side and is safe for Discord because it does
  not require browser callbacks or human approval UI.

## License

MIT
