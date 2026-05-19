# Sturm

A webhook-based Discord bot on Cloudflare Workers.

Discord sends interactions to `/discord`. The Worker verifies Discord request
signatures, handles slash commands, and forwards chat messages into a
Cloudflare Agent Durable Object. Conversations persist per Discord channel or
DM.

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
KAGI_API_KEY=
STURM_DEBUG_TOKEN=
```

Restart `npm run dev` after changing `.dev.vars`.

For production, set secrets in Cloudflare:

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put KAGI_API_KEY
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

Debug locally without Discord:

Set `STURM_DEBUG_TOKEN` in `.dev.vars`, then use that same value in the
authorization header.

```bash
curl -H "authorization: Bearer <debug-token>" \
  -H "content-type: application/json" \
  -d '{"surface":{"type":"guild_channel","guildId":"test-guild","channelId":"test-channel"},"user":{"id":"test-user","displayName":"Test User"},"text":"hello"}' \
  http://localhost:8787/debug/chat
```

```bash
curl -H "authorization: Bearer <debug-token>" \
  -H "content-type: application/json" \
  -d '{"surface":{"type":"guild_channel","guildId":"test-guild","channelId":"test-channel"}}' \
  http://localhost:8787/debug/reset
```

## Notes

- The bot supports `/c text:<message>` and `/reset`.
- `/reset` clears the current channel or DM context only. In guilds, Discord
  limits it by default to members with Manage Messages.
- Responses are deferred immediately, then the original interaction response is
  edited after Workers AI finishes.
- Web search and URL summarization require `KAGI_API_KEY`.

## License

MIT
