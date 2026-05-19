# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command               | Purpose                   |
| --------------------- | ------------------------- |
| `npx wrangler dev`    | Local development         |
| `npx wrangler deploy` | Deploy to Cloudflare      |
| `npx wrangler types`  | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc.

For local Discord slash-command testing, prefer `npm run discord:register:guild`
because guild command updates propagate fastest. Use global registration for
commands that need to work in DMs or production-like behavior.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/

## Project Architecture

- This repo is a Discord webhook bot, not a web UI.
- Keep Discord request verification, command routing, and interaction replies in `src/discord.ts`.
- Keep persistent agent/session behavior in `src/agent.ts`.
- Keep Workers AI model settings, compaction settings, and provider options in `src/model.ts`.
- Keep assistant prompt text in `src/prompts.ts`.
- Keep tool definitions in `src/tools.ts` and provider-specific tool clients in their own modules.
- Conversation identity must remain explicit:
  - Guild channels use `discord:guild:<guild_id>:channel:<channel_id>`.
  - Bot DMs use `discord:dm:<user_id>`.
  - Do not add fallback pooled DM/channel keys.
- `/reset` clears only the current scoped Session via `session.clearMessages()`.
- `webSearch` is backed by Kagi FastGPT in `src/search.ts` and requires `KAGI_API_KEY`.
- Debug HTTP routes live in `src/debug.ts`, require `STURM_DEBUG_TOKEN`, and must reuse the same explicit Discord conversation keys as real interactions. Use stable test identifiers like `test-guild`, `test-channel`, and `test-user` unless real Discord IDs are explicitly needed.
