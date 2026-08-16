<!--
BEGIN Cloudflare C3 generated AGENTS.md baseline.
Source: cloudflare/workers-sdk:packages/create-cloudflare/src/agents-md.ts (`getAgentsMd`).
URL: https://github.com/cloudflare/workers-sdk/blob/main/packages/create-cloudflare/src/agents-md.ts
Do not edit in place. Refresh this block from upstream C3, and put repo-specific guidance under "Sturm Additions".
-->

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

<!-- END Cloudflare C3 generated AGENTS.md baseline -->

---

# Sturm Additions

These instructions are repo-specific additions layered after the Cloudflare C3
baseline above.

## Docs

- Long-running Agents: https://developers.cloudflare.com/agents/concepts/long-running-agents/

## Commands

For local Discord slash-command testing, run `npm run dev`, then register
guild-scoped commands through
`curl -X POST http://localhost:8787/api/admin/register-commands`. This
registers commands in every guild the configured bot is in.
Design principle: use guild-scoped Discord commands for this bot. Do not add
global command registration unless explicitly requested; global command
propagation is too slow for the current development and deployment workflow.

## Runtime Debugging Flow

- Start from the observed symptom and identify the affected surface: Discord interaction, debug endpoint, scheduled task, direct tool call, browser execution, Workers AI/AI Gateway model flow, Durable Object alarm, or Discord REST call.
- Use the Cloudflare MCP/OpenAPI before guessing at platform behavior. For AI Gateway issues, inspect account `40444d2f11999fee857be59abe745754`, gateway `default`, and prefer logs filtered by Sturm metadata (`app: "sturm"`, `correlationId` when available, plus `flow: "reply"`, `"compaction"`, `"memory-reflection"`, or `"channel-context-reflection"`). Check the log row first for model, provider, status, duration, token counts, path, and timestamp, then inspect `/logs/{id}/request` and `/logs/{id}/response` when payload retention is enabled.
- Correlate Cloudflare evidence with app evidence: log IDs, timestamps, Worker event logs, `src/logging.ts` structured messages, debug `correlationId`, Think submission status, delivery status, and memory-reflection status. Distinguish model request/response payloads from metadata-only log rows.
- For direct tool failures, use AI Gateway logs to inspect the model turn and tool call records, then correlate with Worker logs and delivery/debug status by `correlationId`. For `browser_execute` failures, remember the tool is backed by a browser-only Code Mode runtime; inspect the browser tool result, AI Gateway payload, and Worker logs rather than using the removed general Code Mode inspection endpoint.
- Reproduce through the real debug surface when possible: run `npm run dev`, submit `/debug/chat`, and inspect `/debug/status`. Use stable test identifiers (`test-guild`, `test-channel`, `test-user`) unless real Discord API behavior matters; for real Discord checks use guild `556940307011338329` and test user `622546383462727690`.
- Prefer read-only smoke checks before mutations. For tool issues, first verify the AI Gateway request exposes the expected direct tool schema, then run a read-only tool call through `/debug/chat`. Only run mutating tools when the user explicitly approves the real side effect.
- When reporting results, include the concrete evidence: checks run, relevant Cloudflare log IDs or timestamps, debug `correlationId`, whether request/response payloads were inspected, and any scope limits such as "read-only tool call only" or "Discord platform delivery not manually verified."

## Prompt Replay Benchmarks

- Only use the opt-in prompt replay benchmark when explicitly benchmarking a change to the chat flow, such as prompt text, context shaping, tool exposure, or model request assembly. It gives a stable retained AI Gateway `request_head` fixture for A/B checks without adding a permanent CI test.
- Store local replay fixtures as gitignored `tests/fixtures/prompt-replay/*.local.json` files. These fixtures may contain private Discord context, so do not commit fixture payloads or generated `*.results.json` files.
- Run prompt replay explicitly with `npm run bench:prompt-replay`; normal `npm test` skips `tests/prompt-replay.benchmark.test.ts`.
- Use fixture `variants` for manual A/B testing, especially `systemReplacements`, `appendSystem`, and `disableTools`. Use fixture `scoring.includeAny` and `scoring.excludeAny` as lightweight behavior counters, not as authoritative correctness claims.
- When reporting replay results, include the source AI Gateway log ID, whether payload retention had a complete request, fixture variant names, run counts, and the exact scoring criteria. Separate model comprehension results from full production behavior when tools are disabled or request fields are edited for benchmarking.

## Project Architecture

- This repo is a Discord webhook bot, not a web UI.
- Commits to `main` auto-deploy the bot to `sturm.j1.io`.
- Keep CI/CD ownership explicit: GitHub Actions provides branch and PR feedback, while Cloudflare Workers Builds is the production deploy gate for `main`. The Workers Builds build command should run `npm run check && npm test` before `npx wrangler deploy`; do not remove Actions unless branch and PR validation has an equivalent replacement, and do not rely on Actions alone to gate production deploys.
- Keep `README.md` slim and user/operator-facing. Do not duplicate architecture, local debug workflows, or agent-maintainer guidance there; put that in `AGENTS.md` instead.
- Treat each Discord conversation Agent as a long-running Cloudflare Agent: it should be a durable identity that wakes on Discord interactions or schedules, persists any work that matters, and must not rely on in-memory flags, timers, open requests, or closures surviving hibernation/eviction. Follow the Long-running Agents doc above when changing queueing, scheduling, recovery, memory, or multi-step tool work.
- Sturm is guild-only for now. Do not add bot DM support, DM command contexts, or `discord:dm:*` conversation keys unless explicitly requested.
- Keep Discord request verification and command routing in `src/discord.ts`; keep outbound Discord API, delivery, turn, format, and shared types in focused modules under `src/discord/`.
- Keep persistent agent/session orchestration in `src/agent.ts`.
- Discord interactions should return the deferred Discord response immediately, then submit the per-conversation Agent work through `ctx.waitUntil()`. Do not run model/tool work from the `/discord` route; the route may only validate, classify, acknowledge, and hand off to the durable Agent submission path.
- Treat `correlationId` as the primary app-wide per-turn correlation ID. When a Discord, debug, scheduled, component, or recovery turn fans out into Think submissions, Discord delivery records, tool calls, AI Gateway metadata, artifacts, memory reflection, or app logs, preserve or reference the originating `correlationId` wherever the boundary supports it. Keep Discord platform interaction IDs as source/protocol metadata, named `discordInteractionId` once the value crosses out of raw Discord interaction handling. Do not use `correlationId` or `discordInteractionId` as authorization, conversation identity, or long-term domain identity; those remain explicit guild/channel/user IDs and conversation names.
- User-visible progress traces must be sanitized status updates generated by Sturm, not raw model reasoning or chain-of-thought. Keep progress generic and throttled through `src/discord/progress.ts`; prefer coarse phases and humanized tool labels, and let the final Discord response replace any interim progress text.
- Keep the final Think model step reserved for a user-facing response by disabling tools in `beforeStep()`. If the model still exhausts the step budget without text or artifacts, deliver an explicit bounded-work message instead of the generic empty-response fallback, preserve completed tool activity in durable history for an explicit follow-up, and do not auto-continue into another turn.
- Model-produced text that is delivered to users, stored in assistant history, or persisted as derived context must pass through the shared model-output sanitizer so raw thinking traces such as `<think>...</think>` or stray leading `</think>` prefixes do not leak into Discord or durable conversation state. Keep this as generic output-boundary cleanup; do not add feature-specific content trimming for normal model prose.
- `ChatAgent` extends `@cloudflare/think` and uses Think `submitMessages()` for durable chat admission, idempotency, FIFO turn serialization, submission status, and chat recovery. Do not reintroduce a separate custom chat queue unless explicitly requested.
- Keep Discord-specific external delivery state in `DiscordDeliveryStore`: webhook/debug response targets, terminal delivery status, debug results, and generated image artifact metadata. Think owns conversation messages and model turn recovery.
- Think `chatRecovery` wraps programmatic turns in fibers. Use Think hooks (`beforeTurn`, `beforeStep`, `beforeToolCall`, `afterToolCall`, `onChatResponse`, and `onSubmissionStatus`) for turn lifecycle behavior instead of adding an outer Discord job fiber.
- Keep lifecycle ownership explicit: Think owns chat admission, serialization, recovery, and conversation messages; `DiscordDeliveryStore` owns external Discord delivery/debug state; managed `startFiber()` jobs own app-side background work that needs durable acceptance, idempotency, inspection, cancellation, and cleanup; app-specific stores such as the guild memory reflection store own domain outcomes that managed fiber status does not represent.
- Compose prompts so durable instructions and memory remain a stable prefix, with volatile per-turn data such as timestamps and caller/channel context appended after them.
- Model-facing volatile context should follow a snapshot-and-formatter boundary: capture and normalize typed structured data in a focused snapshot module, enrich it before persistence when needed, and render it through a pure formatter module at prompt assembly. Keep orchestration responsible only for timing, failure policy, and placement. Use separate pending and persistent snapshot types when transient protocol fields must not cross a durable boundary. Apply this pattern to cohesive context blocks such as the live caller and live channel transcript; do not force durable memory, tool results, or unrelated one-off values into it.
- Keep prompt instructions at the narrowest layer that needs them. Base assistant prompts should contain broad durable behavior that applies across the bot. Tool descriptions should contain tool-specific usage rules, argument-selection guidance, and preconditions. Code should enforce invariants that must hold even if the model chooses poor arguments. Do not duplicate the same behavioral rule across the base prompt and tool prompts unless both layers independently need it.
- Model-facing tools should expose user intent and app capabilities; runtime code owns platform protocol details, validation, expiry, idempotency, cleanup, and authorization.
- For direct model-facing tools, rely on the Zod input schema as the primary argument contract. Do not duplicate validation that the schema already performs unless there is a real non-model caller path or another boundary that can bypass the schema.
- Tool descriptions must manually state argument-selection constraints the model needs to choose valid values, such as numeric ranges, length limits, and pattern requirements. Keep the Zod schema as the enforcement source, and derive description text from the same constants when practical so the model-facing docs and runtime validation do not drift.
- Direct tool outputs are model-visible. Keep return values concise, structured, and useful as durable history of write tools and other tool activity. Use `toModelOutput` selectively for direct tools when the model benefits from a compact rendered result, action-specific final-response reminder, or same-turn tool handle; include any handle needed for later tool calls but label it as non-user-facing when appropriate. Static behavior rules, final-response rules, argument-selection guidance, and warnings belong primarily in the tool description/schema or broader prompt layer.
- Do not silently transfer Discord user intent or authority. If an action starts from one Discord user but can be completed, approved, modified, or canceled by another, that cross-user authority must be explicit in the tool semantics and enforced in code.
- Prefer lazy model-facing context for bulky or volatile data. Surface details such as caller permission names in targeted tool results or denial messages when they become relevant, not in every normal turn.
- Durable re-entry points such as scheduled tasks, component interactions, queued work, and recovery paths must persist enough task intent to continue correctly after prompt compaction, hibernation, eviction, or restart.
- Model-facing artifact fields should use normal JavaScript camelCase consistently across prompts, formatted context/history, tool schemas, and tool outputs. Use `artifactId` for the durable model-facing artifact handle and `artifactKey` only for internal R2 storage metadata; do not mix in snake_case aliases such as `artifact_id` or `artifact_key`.
- When a Discord turn includes uploaded attachments, freeze supported attachment bytes into the R2-backed artifact model and persist lightweight `artifactId` metadata in conversation history. Model-facing tools should accept explicit `artifactId` values, not R2 `artifactKey` values; keep artifact `source` visible so provenance remains obvious, such as `discord_attachment`, `image_generation`, or `workspace_export`. Artifact tools must resolve only persisted artifact records by `artifactId`; do not add fallback lookup paths through raw Discord attachment IDs, Discord CDN URLs, proxy URLs, ambient channel-wide "latest attachment" caches, or reconstructed legacy attachment metadata.
- Current-turn Discord artifacts should be summarized through the artifact-summary flow when they have supported derived context. Image artifacts currently produce concise `visualSummary` metadata for future text-only turns. Generate summaries as a per-turn side effect that runs in parallel with the main reply but blocks final delivery until complete or timed out using the same reply timeout. Keep summary generation separate from the user-visible assistant response, use the configured artifact-summary model/settings, and prefer a plain image-summary prompt with structured output for image artifacts over brittle content-specific cleanup. Do not fail the main turn if summary generation cannot complete.
- When a user action explicitly pauses for a later continuation, such as a component prompt, approval, or recovery turn, persist a normalized source-turn context on that continuation record for reusable non-attachment request facts needed by tools, such as guild/channel/user/app context. Rehydrate that context into the continuation request, while letting fresh interaction data override authority-sensitive fields such as current user and app permissions. Attachment bytes are preserved through `artifactId` metadata in conversation history and R2 artifacts, not through continuation records. Do not persist raw Discord interaction payloads or interaction tokens as continuation state.
- Any model-facing data with timestamps must use explicit field names and ISO 8601 UTC with a `Z` suffix, for example `sent_at_utc: 2026-06-02T18:14:59.000Z`. Keep event times separate from observation times. Add a tool-specific observation timestamp such as `retrieved_at_utc` only when data may persist, be interpreted outside the current turn, or when several observations in one turn need distinct timing. Omit observation timestamps for per-turn runtime context that is rebuilt immediately before the model call and can rely on `current_timestamp_utc`.
- Use LiquidJS final-response rendering sparingly, only for specific delivery-time transforms or cases where code can prevent model errors by taking brittle formatting, escaping, conversion, or protocol details away from the model. Keep filters narrow, deterministic, and prompt-documented; native Discord/Markdown remains the default response formatting.
- Keep Discord-specific timestamp rendering at the delivery boundary. Do not put relative time phrases, Unix timestamp seconds, or Discord timestamp markup in model-facing prompts, runtime context, domain tool outputs, or session summaries intended for model reasoning. Final response rendering may use narrow LiquidJS filters to convert ISO source values into outbound Discord markup while preserving ISO in model-facing history.
- Prompt caching must stay correct for cross-channel guild memory. Use the guild catalog revision only as a shared-memory change token, not as a write-conflict protocol, and keep the reset epoch separate. Reuse cached memory context while both the catalog revision and memory-rendering contract are unchanged; refresh it when either changes. Keep the revision and epoch runtime-owned rather than rendering them into model context.
- Completed/failed Discord delivery records are pruned by `DiscordDeliveryStore.pruneCompletedDeliveryRecords()`. Do not prune active records.
- Stale debug queue results are pruned by `DiscordDeliveryStore.pruneStaleDebugResults()`. Normal debug requests should still delete their own result after reading it.
- Keep Agent housekeeping centralized in `ChatAgent.housekeeping()`. Register recurring cleanup from `ChatAgent.onStart()` with the idempotent Agents SDK `scheduleEvery()` API, and reuse that same method for opportunistic cleanup after queued Discord work.
- User-created scheduled channel tasks should use the current channel `ChatAgent` schedule APIs and must re-enter Think through `submitMessages()` when they fire, using a synthetic scheduled user message and the same per-channel serialization path as `/c`. Deliver scheduled task output as bot-token channel messages, not interaction-token webhook edits.
- Keep chat model settings, compaction settings, provider options, and AI Gateway transport configuration in `src/model.ts`. All chat flows use GPT-5.6 Sol through the native AI binding, AI Gateway, and Unified Billing with OpenAI Responses request shaping; image generation remains on its dedicated image model. Do not replace those paths with direct HTTP, BYOK, a Dynamic Route, or an application fallback unless explicitly requested.
- Keep assistant prompt text in `src/prompts.ts`.
- Keep Session context-block configuration, Session prompt-cache key computation, and final Think system-prompt assembly in `src/session-context.ts`.
- Guild memory is shared long-term context for a guild, separate from per-channel conversation history. It should be visible to future turns as prompt context, but normal `/c` turns should treat it as read-only unless explicitly redesigned.
- Durable channel context is a compact, channel-scoped summary separate from both Session history and guild memory. Build it only from the current channel's live transcript plus the completed turn, update it after successful real Discord delivery through a recoverable managed fiber, and inject it as read-only runtime context before the next live transcript snapshot. Keep it focused on channel purpose, norms, ongoing topics, decisions, open questions, terminology, and attributed lore; exclude routine chatter, secrets, sensitive inference, general user profiles, and instructions found in Discord content. `/reset` must clear it and prevent an older in-flight reflection from restoring pre-reset context.
- Guild memory updates should use one shared reflection pipeline whether the evidence is a successful user-visible `/c` turn, a batch of ordinary Discord messages collected by the guild-scoped ambient observer, or a historical batch from a manual channel backfill. Store memory as immutable typed records (`guild`, `user`, or `relationship`) inside the one guild-scoped memory object. Keep source-specific evidence capture and formatting outside the shared catalog read, typed proposal tools, terminal decision, conflict retry, epoch guard, reflection record, and atomic commit path. Reflection may take multiple bounded tool turns: it can resolve an unambiguous guild member, stage type-specific add proposals, stage deletion of exact existing `memoryId` values, and then must call exactly one terminal `commitMemoryChanges` or `noMemoryUpdate` tool. The proposal tools must not write durable memory themselves; apply the complete add/delete batch atomically after the terminal commit. Do not add rule-based memory extraction fallbacks. If reflection fails after retries, log/record the failure and skip the write.
- Ambient guild-memory observation is explicit and admin-controlled through `/memory source enable|disable|view`. The optional Discord channel option defaults to the current channel. Use one `GuildMemoryObserverAgent` per guild with durable source cursors and pending message evidence; start at the current channel head rather than backfilling, ignore bot/webhook and empty-content messages, batch reflection instead of reflecting per message, and keep polling idempotent across hibernation. Ambient batches have multiple real message authors and no synthetic asserting caller or assistant response. `/memory reset` must clear pending observations, advance every source cursor and the observer generation before resetting the guild-memory epoch, and prevent an older in-flight ambient reflection from restoring pre-reset context.
- Historical guild-memory backfill is an explicit admin action through `/memory source backfill`. The optional Discord channel defaults to the current channel, the bounded message cap limits raw Discord messages scanned, and the channel must already be an enabled ambient source. Freeze a separate historical boundary when the source is enabled, page backward through the shared Discord message API, spool eligible evidence durably, then reflect it oldest-to-newest through the shared memory pipeline. Keep backfill jobs, cursors, progress, retries, and message spools separate from live observer state. Live collection may continue in parallel, but serialize ambient and backfill model reflections per guild and give ready ambient work priority. `/memory source view` must expose backfill progress; source disable discards matching backfill state, and `/memory reset` discards every backfill job and establishes a new historical boundary. Share pagination, snowflake comparison, filtering, evidence normalization, truncation, and batching helpers between ambient collection and backfill without sharing their durable cursors.
- Treat Discord user IDs as the only durable person identity in typed memory. Runtime code owns the asserting caller, guild, correlation, and timestamp provenance; do not expose those as model-selected tool arguments. A relationship involving multiple users is one record with all stable subject IDs, not duplicated per-user memory. If a name cannot be resolved unambiguously, do not create person-specific memory.
- Guild memory is shared across channels, so writes must be concurrency-safe and retry-safe. Records are immutable: corrections are an atomic delete-plus-add, deletion must still target a current record, and reflection commits must be idempotent by originating `correlationId`. `/memory reset` is an epoch boundary that prevents an older in-flight reflection from restoring pre-reset memory. Independent inserts may merge, while stale targeted changes must reload or stop rather than overwrite newer state.
- Guild memory should have one authoritative durable backing store and one model-facing formatter that renders the active record collection as a coherent `guild_memory` context block. Do not split records into separate per-user stores or histories, and do not mirror them elsewhere unless explicitly requested. Channel history remains scoped to the channel.
- Persist runtime-owned provenance on every guild memory record as `discord_turn`, `ambient_channel`, or `channel_backfill`, alongside its source correlation ID. Do not expose this source enum in model-facing guild memory or reflection context; show it only on operational surfaces such as `/memory view`.
- Use `src/logging.ts` for app logs so operational errors keep consistent structured context. Do not log Discord interaction tokens, API keys, or raw request bodies.
- `DiscordRestDispatcher` is the coordination boundary for bot-token Discord REST calls. Keep route wrappers in `src/discord/api.ts`; app/tool code should not call the dispatcher directly unless adding a new low-level Discord API wrapper.
- Do not bypass `src/discord/api.ts` with direct `fetch` for bot-token Discord API calls. Unauthenticated Discord webhook response edits may stay direct because they are interaction-token webhook calls, not bot-token REST calls.
- The dispatcher is intentionally synchronous from the caller's perspective: a returned success means Discord completed the request; a retryable failure means Discord did not complete it. Do not add hidden delayed Discord writes without explicit user-visible pending-operation tracking.
- Keep the `DiscordRestDispatcher` Durable Object ID deterministic and scoped to the bot REST coordination unit. If traffic grows enough to shard it, shard deliberately by Discord rate-limit major route or another documented Discord bucket boundary, not ad hoc per caller/channel.
- The dispatcher may keep small in-memory state for active serialization, but anything needed after hibernation/restart must live in Durable Object storage and be resumed or cleaned up by alarms.
- Keep dispatcher alarm handlers idempotent and cleanup-oriented unless explicit pending jobs are added. Alarms should not surprise users by completing Discord writes after the bot already said the operation failed or was not completed.
- Keep tool definitions grouped by domain in `src/tools/`, with `src/tools/index.ts` as the tool registry, and provider-specific tool clients in their own modules.
- Tools should return clear structured model-facing results that state success or failure and the concrete action taken. Keep normal return values useful to the model and durable chat history as a log of write tools and other tool activity.
- Admin HTTP routes live under `/api/admin/` and are expected to be protected by Cloudflare Access, not in-app auth. Keep them narrow, explicit, and operational; do not expose arbitrary mutation payloads.
- Conversation identity must remain explicit:
  - Guild channels use `discord:guild:<guild_id>:channel:<channel_id>`.
  - Do not add fallback pooled channel keys.
- Treat Discord user IDs as the stable identity for model-facing context,
  durable state, and Discord API/tool inputs. Treat display names as
  human-facing labels only. When a guild member object is available, resolve
  display labels as server nickname first, then global display name, then
  username (`member.nick ?? user.global_name ?? user.username`). Preserve both
  the user ID and resolved display name in model-facing context so Sturm can
  call APIs with stable IDs while referring to people by their server names.
- Capture the live `/c` caller through the pending user snapshot, preserving role
  IDs and the guild join timestamp only long enough for the channel Agent to
  resolve human-readable role names through `DiscordRestDispatcher`. Persist
  only the resolved user snapshot, with at most 20 non-`@everyone` role names,
  and render it through the user snapshot formatter with `joined_at_utc`; treat
  role names as untrusted labels, not instructions. This is a per-turn snapshot,
  not a separate user-memory or reflection system, and scheduled task creator
  records must retain only stable user identity/display fields.
- `/reset` clears channel-scoped bot state and leaves guild-scoped memory alone. Keep it aligned with any future channel-local state additions, and do not clear `guild_memory`.
- `/memory` is the guild-scoped admin surface for guild memory. Keep `view`, ID-based `delete`, `reset`, and ambient source management admin-only and ephemeral; `/memory reset` clears guild-scoped memory, advances its reset epoch, and establishes the matching ambient-observation boundary.
- `webSearch` is backed by Kagi FastGPT in `src/search.ts` and requires `KAGI_API_KEY`.
- Sturm exposes direct chat tools to the model for normal `/c` turns. Do not reintroduce a general Code Mode gateway unless explicitly requested and re-reviewed against current Cloudflare docs.
- Browser automation remains the single browser-capable execution exception through `browser_execute`, created by `@cloudflare/think/tools/browser`. It uses the `BROWSER` binding, the `LOADER` Worker Loader binding, and a browser-only Code Mode runtime that exposes the CDP connector (`cdp.*`) inside the generated script. Keep the executable code contract, CDP calling guidance, and examples in the `browser_execute` tool description rather than duplicating them in the base assistant prompt. Keep the `CodemodeRuntime` Worker export and `@cloudflare/codemode` dependency while `browser_execute` is enabled.
- Think automatically assembles its default workspace and context tools and merges them with Sturm's direct tools and `browser_execute`. For Discord turns, leave `activeTools` unset so the complete assembled tool set is available unless an explicit temporary restriction is required.
- The current channel Agent's persistent Think workspace is scoped to the current guild channel Agent and should be used by the model-facing workspace tools or app code when work benefits from a virtual filesystem. The default workspace Bash tool is network-disabled and operates only on workspace files. Do not use the workspace as a memory mechanism; keep `guild_memory` as the only long-term memory mechanism for concise cross-channel facts. Users cannot browse workspace paths directly, so tools should return or summarize any file content the user needs to see and use `exportWorkspaceFile` when the user should receive a downloadable file.
- Workspace reset is not an epoch-guarded transactional boundary. A rare already-running workspace operation could still finish after reset. Do not add epoch guards or a custom workspace backend unless this becomes a real observed issue.
- Treat Think sub-agents as a later escalation tool, not a default abstraction. Prefer the parent channel Agent for normal `/c` workflows. Add sub-agents only when a task genuinely needs retained delegated state, specialist prompts, parallel/background work, or isolation from noisy large tasks; keep guild memory and Discord delivery owned by the parent Agent unless explicitly redesigned.
- Debug HTTP routes live in `src/debug.ts`, require `STURM_DEBUG_ENABLED=true`, and must reuse the same explicit Discord conversation keys and durable Think submission path as real interactions. Local `npm run dev` injects that flag with Wrangler `--var`; do not add it to `.dev.vars` unless explicitly needed outside the npm script. Use stable test identifiers like `test-guild`, `test-channel`, and `test-user` unless real Discord IDs are explicitly needed. When real Discord IDs are useful for local/manual testing, use guild `556940307011338329` and test user `622546383462727690`.
- Testing strategy: prefer a small number of smoke-style integration tests that exercise real Worker/debug surfaces and durable Agent paths, with enough coverage to replace recurring manual endpoint checks. Do not add isolated unit tests for this personal bot. Automated tests cannot fully exercise Discord platform behavior such as real interaction delivery, webhook edits, bot-token REST behavior, or command propagation; manually verify Discord itself when that surface changes. Cloudflare-owned flows such as Workers routing, debug endpoints, Durable Object/Agent lifecycle, Think submissions, managed fibers, and durable status inspection should be covered through integration tests where practical. Keep live Workers AI checks opt-in through `npm run test:ai`; the default deploy gate must not depend on live AI remote-binding transport. Integration tests must not write persistent app state into the production bot: keep app-state bindings such as Durable Objects, R2, KV, D1, Queues, and Vectorize local in tests unless an explicitly non-production test resource/environment has been discussed and approved. New integration test cases should be discussed and vetted before being added; maintaining or updating existing integration coverage is fine when behavior changes.
- Response artifacts are R2-backed attachments stored through `src/artifacts.ts` in the `ARTIFACTS_BUCKET` R2 binding (`sturm-artifacts`). Treat generated images and exported workspace files as the same delivery concept: send hydrated bytes as Discord attachments or debug response data, but persist only artifact keys and minimal identity metadata in durable delivery/session state. Use `source` for artifact provenance and `mimeType` for content classification; do not add a separate artifact kind field. Keep rich artifact details such as SHA-256 hashes, provider/model metadata, full generated prompts, Discord source identifiers, and R2 storage keys in internal artifact/delivery records rather than normal model-facing context or assistant history unless the user explicitly asks for diagnostics. Model-facing artifact references should stay compact: include `artifactId`, `source`, filename, MIME type, concise visual summary or description, useful dimensions/aspect ratio, and workspace source paths for workspace exports. Artifact-producing tool results should likewise avoid returning hashes, provider/model metadata, storage keys, or full prompt dumps; keep `artifactId` only as a same-turn tool handle and explain in the tool description that it is not final-response text. Do not persist raw base64/image bytes, file sizes, or redundant immutability explanations in Session history, Think submissions, or delivery records.
- Image generation is a chat tool backed by Workers AI in `src/images.ts` and stores generated image artifacts under `images/generated/`. Workspace file exports use the `exportWorkspaceFile` chat tool and store exported file artifacts under `files/workspace/`.
- Discord member lookup is a read-only chat tool that searches current-guild users by username or nickname prefix. Nickname postfix changes are chat tools that require an explicit target Discord user ID, use `DISCORD_TOKEN`, and require the `/c` caller's Manage Nicknames permission. Do not maintain separate bot permission preflight lists; let Discord API responses report bot permission or role hierarchy failures.
- User-facing bot capabilities should generally be chat tools behind `/c`, not separate slash commands, unless the user explicitly asks for a separate command.
- Out-of-band meta-admin commands are the exception to the single-command rule. Keep them as separate slash commands when they manage bot state, maintenance, or operator workflows that should not cloud the normal `/c` chat flow for users. These commands must return ephemeral Discord responses by default.
