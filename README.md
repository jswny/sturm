# Sturm

A Discord bot on Cloudflare Workers.

Sturm responds to `/c text:<message>` in Discord guild channels. It keeps
conversation context per channel, shares durable memory across the guild, and can
use tools for web search, page inspection, URL summaries, archiving, image generation, member
lookup, and nickname postfix changes. DMs are not supported.

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
KAGI_API_KEY=
```

Restart local development after changing `.dev.vars`.

Set production secrets in Cloudflare:

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put KAGI_API_KEY
```

Create the R2 bucket used for generated image artifacts before deploying:

```bash
npx wrangler r2 bucket create sturm-artifacts
```

Run locally:

```bash
npm run dev
```

Deploy:

```bash
npm run deploy
```

## Discord

Set the Discord Developer Portal Interactions Endpoint URL to:

```text
https://<worker-host>/discord
```

Register `/c`, `/reset`, and `/memory` in every guild the bot is in:

```bash
curl -X POST https://<worker-host>/api/admin/register-commands
```

For local development, use the local Worker URL instead:

```bash
curl -X POST http://localhost:8787/api/admin/register-commands
```

The admin endpoint is intended to be protected by Cloudflare Access. Sturm only
registers guild-scoped commands.

Inspect recent Code Mode executions for a guild channel:

```bash
curl -X POST https://<worker-host>/api/admin/codemode/inspect \
  -H "Content-Type: application/json" \
  --data '{"surface":{"type":"guild_channel","guildId":"<guild-id>","channelId":"<channel-id>"},"interactionId":"<interaction-id>"}'
```

## Commands

- `/c text:<message>` chats with Sturm.
- `/reset` clears the current channel context only; it does not clear guild
  memory. Discord limits it by default to members with Manage Messages.
- `/memory view`, `/memory delete index:<number>`, and `/memory reset` manage
  guild memory. Discord limits them by default to members with Manage Server.

## License

MIT
