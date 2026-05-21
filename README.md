# Sturm

A webhook-based Discord bot on Cloudflare Workers.

Discord sends interactions to `/discord`. The Worker verifies Discord request
signatures, handles slash commands, and enqueues chat messages in a Cloudflare
Agent Durable Object. Conversations persist per Discord guild channel. DMs are
not supported right now.

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
STURM_DEBUG_TOKEN=
```

Restart `npm run dev` after changing `.dev.vars`.

For production, set secrets in Cloudflare:

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put KAGI_API_KEY
```

Create the R2 bucket used for generated image artifacts before deploying:

```bash
npx wrangler r2 bucket create sturm-artifacts
```

`DISCORD_APPLICATION_ID` is used for health output and command registration.
`DISCORD_TOKEN` is used by the Worker for authenticated Discord bot API tools
and command registration.

## Commands

Register `/c` and `/reset` in every guild the bot is in:

```bash
curl -X POST http://localhost:8787/api/admin/register-commands
```

Sturm only registers guild-scoped commands. Guild command updates propagate
quickly, and DM commands are intentionally not supported right now.

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

For the deployed bot:

```bash
curl -X POST https://<worker-host>/api/admin/register-commands
```

This admin endpoint is intended to be protected by Cloudflare Access. It does
not implement its own bearer-token authentication.

Debug locally without Discord:

Set `STURM_DEBUG_TOKEN` in `.dev.vars`, then use that same value in the
authorization header. Debug chat and reset requests use the same durable
per-conversation queue as real Discord interactions, then return the queued
result.
For permission-gated tools, include a Discord permission bitfield in
`permissions.user`; for example, Manage Nicknames is `134217728`.

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
- `/reset` clears the current guild channel context only. Discord limits it by
  default to members with Manage Messages.
- Responses are deferred after the interaction is durably queued, then the
  per-channel Agent drains queued jobs linearly and edits the original
  interaction response after Workers AI finishes.
- Completed queue dedupe records are pruned after seven days; pending jobs are
  preserved.
- Stale debug queue results are pruned after one day; normal debug requests
  delete their result after it is returned.
- Web search and URL summarization require `KAGI_API_KEY`.
- URL archiving creates archive.today latest links from chat tool calls.
- Image generation uses Workers AI, stores generated artifacts in the
  `sturm-artifacts` R2 bucket under `images/generated/`, and returns Discord
  attachments.
- Nickname postfix changes require `DISCORD_TOKEN` and Discord Manage Nicknames
  permission for the `/c` caller. Discord API errors are surfaced when bot
  permissions or role hierarchy block a target.

## License

MIT
