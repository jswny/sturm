# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- Long-running Agents: https://developers.cloudflare.com/agents/concepts/long-running-agents/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command               | Purpose                   |
| --------------------- | ------------------------- |
| `npx wrangler dev`    | Local development         |
| `npx wrangler deploy` | Deploy to Cloudflare      |
| `npx wrangler types`  | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc.

For local Discord slash-command testing, run `npm run dev`, then register
guild-scoped commands through
`curl -X POST http://localhost:8787/api/admin/register-commands`. This
registers commands in every guild the configured bot is in.
Design principle: use guild-scoped Discord commands for this bot. Do not add
global command registration unless explicitly requested; global command
propagation is too slow for the current development and deployment workflow.

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
- Treat each Discord conversation Agent as a long-running Cloudflare Agent: it should be a durable identity that wakes on Discord interactions or schedules, persists any work that matters, and must not rely on in-memory flags, timers, open requests, or closures surviving hibernation/eviction. Follow the Long-running Agents doc above when changing queueing, scheduling, recovery, memory, or multi-step tool work.
- Sturm is guild-only for now. Do not add bot DM support, DM command contexts, or `discord:dm:*` conversation keys unless explicitly requested.
- Keep Discord request verification and command routing in `src/discord.ts`; keep outbound Discord API, queue, turn, format, and shared types in focused modules under `src/discord/`.
- Keep persistent agent/session orchestration in `src/agent.ts`.
- Discord interactions should be durably queued in the per-conversation Agent before returning the deferred Discord response. Do not run model/tool work from the `/discord` route with `ctx.waitUntil`.
- Use the Agents SDK built-in queue (`this.queue`) as the FIFO/retry mechanism for Discord work. Keep Discord-specific state in `DiscordInteractionStore`: interaction dedupe, attempt counts, generated response checkpoints, debug results, and terminal status.
- Queued Discord job attempts run inside `runFiber()` for recoverable active execution. Fibers are only the active-work recovery wrapper; keep fiber snapshots small and metadata-only, and use `onFiberRecovered()` to requeue still-active interactions through the SDK queue.
- Completed/failed Discord interaction dedupe records are pruned by `DiscordInteractionStore.pruneCompletedInteractionRecords()`. Do not prune active records.
- Stale debug queue results are pruned by `DiscordInteractionStore.pruneStaleDebugResults()`. Normal debug requests should still delete their own result after reading it.
- Keep Workers AI model settings, compaction settings, and provider options in `src/model.ts`.
- Keep assistant prompt text in `src/prompts.ts`.
- Guild memory must keep the Agents SDK memory APIs as the public model: use `Session.withContext("guild_memory", ...)`, `session.tools()`, and the SDK-generated `set_context` tool. Do not replace this with a custom memory tool unless explicitly requested.
- Guild memory is shared across channels in the same guild, so the provider must treat it as multi-writer state. `GuildMemoryProvider` in `src/memory.ts` uses the `GuildMemory` Durable Object as the per-guild backing authority. Same-version writes are accepted, obvious append deltas are merged, and stale replacement edits return a clear conflict error through `set_context`. The Agents SDK provider API receives final block text rather than the raw `append`/`replace` action, so append handling is inferred from the text delta against the provider's last read snapshot.
- `GuildMemory` Durable Objects are keyed as `discord:guild:<guild_id>:memory` and are the only storage for guild memory. Do not mirror guild memory to R2 unless explicitly requested. Channel Session history remains per guild channel.
- Use `src/logging.ts` for app logs so operational errors keep consistent structured context. Do not log Discord interaction tokens, API keys, or raw request bodies.
- Keep tool definitions grouped by domain in `src/tools/`, with `src/tools/index.ts` as the tool registry, and provider-specific tool clients in their own modules.
- Tools should return clear plaintext model-facing results that state success or failure and the concrete action taken. This keeps chat history useful as a log of write tools and other tool activity.
- Admin HTTP routes live under `/api/admin/` and are expected to be protected by Cloudflare Access, not in-app auth. Keep them narrow, explicit, and operational; do not expose arbitrary mutation payloads.
- Conversation identity must remain explicit:
  - Guild channels use `discord:guild:<guild_id>:channel:<channel_id>`.
  - Do not add fallback pooled channel keys.
- `/reset` clears only the current scoped Session via `session.clearMessages()`; it does not clear `guild_memory`.
- `webSearch` is backed by Kagi FastGPT in `src/search.ts` and requires `KAGI_API_KEY`.
- Debug HTTP routes live in `src/debug.ts`, require `STURM_DEBUG_TOKEN`, and must reuse the same explicit Discord conversation keys and durable queue path as real interactions. Use stable test identifiers like `test-guild`, `test-channel`, and `test-user` unless real Discord IDs are explicitly needed.
- Image generation is a chat tool backed by Workers AI in `src/images.ts` and stores artifacts in the `ARTIFACTS_BUCKET` R2 binding (`sturm-artifacts`) under `images/generated/`. Treat generated images as response artifacts: send them as Discord attachments or debug response data, but persist only R2 keys and metadata in durable queue/session state. Never store raw base64/image bytes in Session history or queued job records.
- Nickname postfix changes are chat tools that use `DISCORD_TOKEN` and require the `/c` caller's Manage Nicknames permission. Do not maintain separate bot permission preflight lists; let Discord API responses report bot permission or role hierarchy failures.
- User-facing bot capabilities should generally be chat tools behind `/c`, not separate slash commands, unless the user explicitly asks for a separate command.
