import {
  generateText,
  hasToolCall,
  stepCountIs,
  tool,
  type LanguageModel
} from "ai";
import { z } from "zod";
import type { DiscordChatRequest } from "./discord/types";
import { formatGuildMemoryReflectionContext } from "./guild-memory-formatter";
import type {
  GuildMemoryCatalog,
  GuildMemoryCommitResult,
  GuildMemoryMutation
} from "./memory";
import {
  MEMORY_REFLECTION_PROVIDER_OPTIONS,
  type ModelProviderOptions
} from "./model";
import type { GuildMemberSearchResult } from "./nickname";
import { isTimestampBefore, pruneDurableStorageRecords } from "./storage-prune";

const GUILD_MEMORY_REFLECTION_PREFIX = "guild-memory-reflection:";
const MEMORY_REFLECTION_RECORD_PRUNE_BATCH_SIZE = 100;
const MEMORY_REFLECTION_MODEL_ATTEMPTS = 2;
const MEMORY_REFLECTION_MAX_STEPS = 8;
const MEMORY_CONTENT_MAX_LENGTH = 500;
const MEMORY_RELATIONSHIP_MAX_USERS = 8;

const memoryContentSchema = z
  .string()
  .min(1)
  .max(MEMORY_CONTENT_MAX_LENGTH)
  .describe(
    `Concise complete memory content, from 1 to ${MEMORY_CONTENT_MAX_LENGTH} characters.`
  );

const rememberGuildFactInputSchema = z.object({
  content: memoryContentSchema
});

const rememberUserFactInputSchema = z.object({
  subjectUserId: z
    .string()
    .min(1)
    .describe("Stable Discord user ID for the person this memory is about."),
  content: memoryContentSchema
});

const rememberRelationshipFactInputSchema = z.object({
  subjectUserIds: z
    .array(z.string().min(1))
    .min(2)
    .max(MEMORY_RELATIONSHIP_MAX_USERS)
    .describe(
      `Two to ${MEMORY_RELATIONSHIP_MAX_USERS} distinct stable Discord user IDs involved in the relationship.`
    ),
  content: memoryContentSchema
});

const forgetMemoryInputSchema = z.object({
  memoryId: z
    .string()
    .min(1)
    .describe("Exact memoryId of an existing memory record to remove.")
});

const resolveGuildMemberInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(100)
    .describe("Discord username, global display name, or guild nickname.")
});

const terminalInputSchema = z.object({});

export type GuildMemoryReflectionOperation = "no_change" | "commit";

export type GuildMemoryReflectionPlan = {
  decision: GuildMemoryReflectionOperation;
  mutations: GuildMemoryMutation[];
  attempts: number;
};

export type GuildMemoryReflectionRecord = {
  correlationId: string;
  discordInteractionId?: string;
  status: "running" | "completed" | "failed" | "aborted";
  createdAt: string;
  updatedAt: string;
  changed?: boolean;
  operation?: GuildMemoryReflectionOperation;
  addedCount?: number;
  deletedCount?: number;
  attempts?: number;
  reason?: string;
  error?: string;
};

export type GuildMemoryReflectionSummary = {
  changed: boolean;
  operation: GuildMemoryReflectionOperation;
  addedCount?: number;
  deletedCount?: number;
  attempts?: number;
  reason?: string;
};

export type GuildMemoryReflectionFiberPhase =
  | "input"
  | "reflected"
  | "written"
  | "completed";

export type GuildMemoryReflectionSnapshot = {
  kind: "guild_memory_reflection";
  version: 1;
  phase: GuildMemoryReflectionFiberPhase;
  correlationId: string;
  discordInteractionId?: string;
  request: DiscordChatRequest;
  assistantText: string;
  reflection?: GuildMemoryReflectionSummary;
};

export type ReflectGuildMemoryInput = {
  model: LanguageModel;
  currentCatalog: GuildMemoryCatalog;
  request: DiscordChatRequest;
  assistantText: string;
  searchGuildMembers?: (query: string) => Promise<GuildMemberSearchResult>;
  providerOptions?: ModelProviderOptions;
};

export class GuildMemoryReflectionStore {
  constructor(private storage: DurableObjectStorage) {}

  async get(correlationId: string) {
    return this.storage.get<GuildMemoryReflectionRecord>(
      getMemoryReflectionRecordKey(correlationId)
    );
  }

  async markRunning(correlationId: string, discordInteractionId?: string) {
    const now = new Date().toISOString();
    return this.storage.transaction(async (txn) => {
      const key = getMemoryReflectionRecordKey(correlationId);
      const existing = await txn.get<GuildMemoryReflectionRecord>(key);
      if (existing?.status === "completed") {
        return { started: false, record: existing };
      }

      const record = {
        correlationId,
        discordInteractionId:
          existing?.discordInteractionId ?? discordInteractionId,
        status: "running",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      } satisfies GuildMemoryReflectionRecord;
      await txn.put(key, record);
      return { started: true, record };
    });
  }

  async complete(
    correlationId: string,
    reflection: GuildMemoryReflectionSummary
  ) {
    await this.writeTerminalRecord(correlationId, {
      status: "completed",
      changed: reflection.changed,
      operation: reflection.operation,
      addedCount: reflection.addedCount,
      deletedCount: reflection.deletedCount,
      attempts: reflection.attempts,
      reason: reflection.reason
    });
  }

  async fail(correlationId: string, error: string) {
    await this.writeTerminalRecord(correlationId, {
      status: "failed",
      error
    });
  }

  async abort(correlationId: string, error: string) {
    await this.writeTerminalRecord(correlationId, {
      status: "aborted",
      error
    });
  }

  async pruneTerminalRecords(retentionMs: number) {
    const cutoffMs = Date.now() - retentionMs;
    return pruneDurableStorageRecords<GuildMemoryReflectionRecord>(
      this.storage,
      {
        prefix: GUILD_MEMORY_REFLECTION_PREFIX,
        limit: MEMORY_REFLECTION_RECORD_PRUNE_BATCH_SIZE,
        shouldPrune: (record) => isTimestampBefore(record.updatedAt, cutoffMs)
      }
    );
  }

  private async writeTerminalRecord(
    correlationId: string,
    update: Pick<GuildMemoryReflectionRecord, "status"> &
      Partial<GuildMemoryReflectionRecord>
  ) {
    const now = new Date().toISOString();
    const key = getMemoryReflectionRecordKey(correlationId);
    const existing = await this.storage.get<GuildMemoryReflectionRecord>(key);
    await this.storage.put<GuildMemoryReflectionRecord>(key, {
      correlationId,
      discordInteractionId: existing?.discordInteractionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...update
    } as GuildMemoryReflectionRecord);
  }
}

export async function reflectGuildMemoryAfterTurn(
  input: ReflectGuildMemoryInput
): Promise<GuildMemoryReflectionPlan> {
  let lastError: unknown;

  for (
    let attempt = 1;
    attempt <= MEMORY_REFLECTION_MODEL_ATTEMPTS;
    attempt++
  ) {
    try {
      const plan = await generateMemoryReflectionPlan(input);
      return { ...plan, attempts: attempt };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Guild memory reflection failed.");
}

export function getGuildMemoryReflectionSummary(
  plan: GuildMemoryReflectionPlan,
  commit?: GuildMemoryCommitResult
): GuildMemoryReflectionSummary {
  if (plan.decision === "no_change") {
    return {
      changed: false,
      operation: "no_change",
      attempts: plan.attempts
    };
  }

  return {
    changed: commit?.changed ?? plan.mutations.length > 0,
    operation: "commit",
    ...(commit
      ? {
          addedCount: commit.addedCount,
          deletedCount: commit.deletedCount
        }
      : {}),
    attempts: plan.attempts
  };
}

export function getGuildMemoryReflectionFiberName(correlationId: string) {
  return `${GUILD_MEMORY_REFLECTION_PREFIX}${correlationId}`;
}

export function getGuildMemoryReflectionCorrelationId(name: string) {
  if (!name.startsWith(GUILD_MEMORY_REFLECTION_PREFIX)) return undefined;
  const correlationId = name.slice(GUILD_MEMORY_REFLECTION_PREFIX.length);
  return correlationId || undefined;
}

export function createGuildMemoryReflectionSnapshot(
  request: DiscordChatRequest,
  assistantText: string
): GuildMemoryReflectionSnapshot {
  return {
    kind: "guild_memory_reflection",
    version: 1,
    phase: "input",
    correlationId: request.correlationId,
    discordInteractionId: request.discordInteractionId,
    request,
    assistantText
  };
}

export function parseGuildMemoryReflectionSnapshot(
  value: unknown
): GuildMemoryReflectionSnapshot | null {
  if (!isObject(value)) return null;
  if (value.kind !== "guild_memory_reflection") return null;
  if (value.version !== 1) return null;
  if (!isGuildMemoryReflectionPhase(value.phase)) return null;
  if (typeof value.correlationId !== "string") return null;
  if (typeof value.assistantText !== "string") return null;
  if (!isObject(value.request)) return null;
  if (typeof value.request.correlationId !== "string") return null;
  if (typeof value.request.text !== "string") return null;

  const reflection = parseGuildMemoryReflectionSummary(value.reflection);
  if (value.reflection !== undefined && !reflection) return null;

  return {
    kind: "guild_memory_reflection",
    version: 1,
    phase: value.phase,
    correlationId: value.correlationId,
    discordInteractionId:
      typeof value.discordInteractionId === "string"
        ? value.discordInteractionId
        : undefined,
    request: value.request as DiscordChatRequest,
    assistantText: value.assistantText,
    ...(reflection ? { reflection } : {})
  };
}

async function generateMemoryReflectionPlan(input: ReflectGuildMemoryInput) {
  const mutations: GuildMemoryMutation[] = [];
  const terminalDecisions: GuildMemoryReflectionOperation[] = [];
  const currentRecordsById = new Map(
    input.currentCatalog.records.map((record) => [record.memoryId, record])
  );
  const knownUserIds = getKnownUserIds(input);

  await generateText({
    model: input.model,
    system: MEMORY_REFLECTION_SYSTEM_PROMPT,
    prompt: createMemoryReflectionPrompt(input),
    tools: createMemoryReflectionTools({
      input,
      mutations,
      terminalDecisions,
      currentRecordsById,
      knownUserIds
    }),
    toolChoice: "required",
    stopWhen: [
      hasToolCall("commitMemoryChanges"),
      hasToolCall("noMemoryUpdate"),
      stepCountIs(MEMORY_REFLECTION_MAX_STEPS)
    ],
    providerOptions: input.providerOptions ?? MEMORY_REFLECTION_PROVIDER_OPTIONS
  });

  if (terminalDecisions.length !== 1) {
    throw new Error(
      `Guild memory reflection expected exactly one terminal tool call, received ${terminalDecisions.length}.`
    );
  }

  const normalizedMutations = normalizeMutations(mutations);
  const decision = terminalDecisions[0];
  if (decision === "commit" && normalizedMutations.length === 0) {
    throw new Error(
      "Guild memory reflection committed without proposing any memory changes."
    );
  }
  if (decision === "no_change" && normalizedMutations.length > 0) {
    throw new Error(
      "Guild memory reflection proposed memory changes and then selected noMemoryUpdate."
    );
  }

  return {
    decision,
    mutations: normalizedMutations
  } satisfies Omit<GuildMemoryReflectionPlan, "attempts">;
}

function createMemoryReflectionTools(context: {
  input: ReflectGuildMemoryInput;
  mutations: GuildMemoryMutation[];
  terminalDecisions: GuildMemoryReflectionOperation[];
  currentRecordsById: Map<string, GuildMemoryCatalog["records"][number]>;
  knownUserIds: Set<string>;
}) {
  return {
    resolveGuildMember: tool({
      description:
        "Resolve one Discord username or nickname into a stable user ID before proposing user or relationship memory. A result is usable only when there is one sole or exact member match. Do not guess from ambiguous results.",
      inputSchema: resolveGuildMemberInputSchema,
      execute: async ({ query }) => {
        if (!context.input.searchGuildMembers) {
          return {
            ok: false,
            query,
            error: "Guild member resolution is unavailable."
          };
        }

        const result = await context.input.searchGuildMembers(query);
        const matches = result.results ?? [];
        const resolved = getUnambiguousMemberMatch(query, matches);
        if (result.ok && resolved) {
          context.knownUserIds.add(resolved.id);
          return {
            ok: true,
            query: result.query,
            resolvedUserId: resolved.id,
            displayName: resolved.displayName
          };
        }

        return {
          ok: result.ok,
          query: result.query,
          matches: matches.map((match) => ({
            userId: match.id,
            displayName: match.displayName,
            username: match.username
          })),
          error:
            result.error ??
            (matches.length === 0
              ? "No guild members matched."
              : "Multiple guild members matched; no stable identity was resolved.")
        };
      }
    }),
    rememberGuildFact: tool({
      description:
        "Stage one durable guild-wide fact, convention, preference, or piece of server lore that is not owned by a specific person.",
      inputSchema: rememberGuildFactInputSchema,
      execute: ({ content }) => {
        context.mutations.push({
          type: "add",
          kind: "guild",
          content,
          subjectUserIds: []
        });
        return "Guild memory proposal staged.";
      }
    }),
    rememberUserFact: tool({
      description:
        "Stage one durable fact or preference about exactly one Discord user. subjectUserId must be the caller, an explicit Discord mention, an existing memory subject, or an ID returned by resolveGuildMember.",
      inputSchema: rememberUserFactInputSchema,
      execute: ({ subjectUserId, content }) => {
        requireKnownUserIds([subjectUserId], context.knownUserIds);
        context.mutations.push({
          type: "add",
          kind: "user",
          content,
          subjectUserIds: [subjectUserId]
        });
        return "User memory proposal staged.";
      }
    }),
    rememberRelationshipFact: tool({
      description:
        "Stage one durable relationship or attributed piece of lore involving at least two Discord users. Every subject must use a stable ID already known from the turn, existing memory, or resolveGuildMember.",
      inputSchema: rememberRelationshipFactInputSchema,
      execute: ({ subjectUserIds, content }) => {
        const distinctUserIds = [...new Set(subjectUserIds)];
        if (distinctUserIds.length < 2) {
          throw new Error(
            "Relationship memory requires at least two distinct Discord user IDs."
          );
        }
        requireKnownUserIds(distinctUserIds, context.knownUserIds);
        context.mutations.push({
          type: "add",
          kind: "relationship",
          content,
          subjectUserIds: distinctUserIds
        });
        return "Relationship memory proposal staged.";
      }
    }),
    forgetMemory: tool({
      description:
        "Stage deletion of one exact existing memory record. Corrections require forgetting the outdated record and staging a complete replacement with the appropriate remember tool.",
      inputSchema: forgetMemoryInputSchema,
      execute: ({ memoryId }) => {
        if (!context.currentRecordsById.has(memoryId)) {
          throw new Error(`No current guild memory has memoryId ${memoryId}.`);
        }
        context.mutations.push({ type: "delete", memoryId });
        return "Guild memory deletion proposal staged.";
      }
    }),
    commitMemoryChanges: tool({
      description:
        "Finish reflection and atomically commit all staged add and delete proposals. Call this exactly once after staging every necessary change.",
      inputSchema: terminalInputSchema,
      execute: () => {
        context.terminalDecisions.push("commit");
        return "Guild memory proposals ready for atomic commit.";
      }
    }),
    noMemoryUpdate: tool({
      description:
        "Finish reflection without changing guild memory. Call this exactly once only when no memory proposals were staged.",
      inputSchema: terminalInputSchema,
      execute: () => {
        context.terminalDecisions.push("no_change");
        return "No guild memory update recorded.";
      }
    })
  };
}

function createMemoryReflectionPrompt(input: ReflectGuildMemoryInput) {
  return [
    "Current guild memory records:",
    fence(formatGuildMemoryReflectionContext(input.currentCatalog)),
    "",
    "Latest completed Discord turn:",
    fence(formatLatestTurn(input.request, input.assistantText))
  ].join("\n");
}

function formatLatestTurn(request: DiscordChatRequest, assistantText: string) {
  return [
    "User:",
    `discord_user_id: ${request.user?.id ?? request.userId ?? "unknown"}`,
    request.user?.displayName
      ? `display_name: ${request.user.displayName}`
      : "",
    `guild_id: ${request.guildId ?? "unknown"}`,
    `channel_id: ${request.channelId ?? "unknown"}`,
    "message:",
    truncateForReflection(request.text),
    "",
    "Assistant response:",
    truncateForReflection(assistantText)
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function getKnownUserIds(input: ReflectGuildMemoryInput) {
  const knownUserIds = new Set<string>();
  const callerUserId = input.request.user?.id ?? input.request.userId;
  if (callerUserId) knownUserIds.add(callerUserId);
  for (const record of input.currentCatalog.records) {
    for (const userId of record.subjectUserIds) knownUserIds.add(userId);
    if (record.assertedByUserId) knownUserIds.add(record.assertedByUserId);
  }
  for (const match of input.request.text.matchAll(/<@!?(\d+)>/g)) {
    if (match[1]) knownUserIds.add(match[1]);
  }
  return knownUserIds;
}

function requireKnownUserIds(userIds: string[], knownUserIds: Set<string>) {
  const unknownUserIds = userIds.filter((userId) => !knownUserIds.has(userId));
  if (unknownUserIds.length === 0) return;
  throw new Error(
    `Unknown Discord user IDs: ${unknownUserIds.join(", ")}. Resolve names before proposing memory.`
  );
}

function getUnambiguousMemberMatch(
  query: string,
  matches: NonNullable<GuildMemberSearchResult["results"]>
) {
  if (matches.length === 1) return matches[0];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const exactMatches = matches.filter((match) =>
    [match.username, match.globalName, match.nickname, match.displayName].some(
      (label) => label?.trim().toLocaleLowerCase() === normalizedQuery
    )
  );
  return exactMatches.length === 1 ? exactMatches[0] : undefined;
}

function normalizeMutations(mutations: GuildMemoryMutation[]) {
  const seen = new Set<string>();
  const normalized: GuildMemoryMutation[] = [];
  for (const mutation of mutations) {
    const key =
      mutation.type === "delete"
        ? `delete:${mutation.memoryId}`
        : JSON.stringify([
            "add",
            mutation.kind,
            [...mutation.subjectUserIds].sort(),
            mutation.content.trim().toLocaleLowerCase()
          ]);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(
      mutation.type === "delete"
        ? mutation
        : {
            ...mutation,
            content: mutation.content.trim(),
            subjectUserIds: [...new Set(mutation.subjectUserIds)]
          }
    );
  }
  return normalized;
}

function fence(value: string) {
  return `<content>\n${value}\n</content>`;
}

function truncateForReflection(value: string, maxLength = 4000) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}\n[truncated]`;
}

function getMemoryReflectionRecordKey(correlationId: string) {
  return `${GUILD_MEMORY_REFLECTION_PREFIX}${correlationId}`;
}

function parseGuildMemoryReflectionSummary(value: unknown) {
  if (value === undefined) return undefined;
  if (!isObject(value)) return null;
  if (typeof value.changed !== "boolean") return null;

  const operation = parseGuildMemoryReflectionOperation(value.operation);
  if (!operation) return null;
  if (value.attempts !== undefined && typeof value.attempts !== "number") {
    return null;
  }
  if (value.addedCount !== undefined && typeof value.addedCount !== "number") {
    return null;
  }
  if (
    value.deletedCount !== undefined &&
    typeof value.deletedCount !== "number"
  ) {
    return null;
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    return null;
  }

  return {
    changed: value.changed,
    operation,
    ...(typeof value.addedCount === "number"
      ? { addedCount: value.addedCount }
      : {}),
    ...(typeof value.deletedCount === "number"
      ? { deletedCount: value.deletedCount }
      : {}),
    ...(typeof value.attempts === "number" ? { attempts: value.attempts } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {})
  } satisfies GuildMemoryReflectionSummary;
}

function parseGuildMemoryReflectionOperation(
  value: unknown
): GuildMemoryReflectionOperation | null {
  if (value === "no_change") return "no_change";
  if (value === "commit" || value === "append" || value === "replace") {
    return "commit";
  }
  return null;
}

function isGuildMemoryReflectionPhase(
  value: unknown
): value is GuildMemoryReflectionFiberPhase {
  return (
    value === "input" ||
    value === "reflected" ||
    value === "written" ||
    value === "completed"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const MEMORY_REFLECTION_SYSTEM_PROMPT = `You are Sturm's private guild memory extractor. The main assistant has already replied to the Discord user. Maintain concise durable memory shared across channels in this Discord guild.

Memory records are immutable. You may stage zero or more typed add/delete proposals across multiple tool turns, then you must finish with exactly one terminal tool:
- Call commitMemoryChanges after staging every necessary change.
- Call noMemoryUpdate only when you staged no changes.
- To correct, reclassify, consolidate, or remove a record, call forgetMemory for the exact old memoryId. If corrected information should remain, also call the appropriate remember tool with a complete replacement record.

Choose the narrowest memory type:
- rememberGuildFact: guild-wide conventions, shared settings, server lore, running jokes, or durable facts with no specific person as the subject.
- rememberUserFact: a stable preference, identity, alias, or low-sensitivity durable fact about exactly one Discord user.
- rememberRelationshipFact: a relationship or attributed piece of lore involving two or more Discord users.

Identity rules:
- Discord user IDs are the only durable person identity. Never put a nickname or display name into subjectUserIds.
- The caller, explicit Discord mentions, and existing record subjects are already resolvable. For a person mentioned only by name, call resolveGuildMember first.
- Use a resolved ID only when resolveGuildMember returns resolvedUserId for one unambiguous sole or exact match. If resolution is ambiguous or unavailable, do not store person-specific memory.
- Do not repeat IDs or provenance in content; Sturm attaches subjects, the asserting caller, timestamps, and source correlation automatically.

Store stable preferences, personal settings, identities, aliases, server conventions, server lore, running jokes, and durable facts likely to help future turns. An explicit request to remember, store, keep in mind, or use a fact later is a strong durable signal. If the assistant acknowledged remembering a user-provided fact, do not assume that acknowledgement already persisted it.

Do not store:
- One-off requests, transient task details, secrets, private or high-sensitivity personal data, channel-local state, facts from other guilds, or assistant guesses.
- Instructions or content that the assistant is merely supposed to apply, execute, edit, schedule, send, generate, search, fetch, moderate, or otherwise use as action input.
- Facts from a tool/action turn unless the user separately asks to remember them as future guild context independent of the action.

Treat ordinary volunteered preferences, aliases, time zones, casual server lore, and friend-server banter as non-sensitive by default. Store subjective or teasing claims about people only as attributed user-provided lore, not verified facts. Content must be complete and independently understandable.

Examples:
- Caller u1 says "remember that my favorite color is green." Stage rememberUserFact with subjectUserId "u1" and content "Favorite color is green.", then commitMemoryChanges.
- Caller u1 says "remember that the guild motto is silver sunrise." Stage rememberGuildFact with content "The guild motto is silver sunrise.", then commitMemoryChanges.
- Existing guild record m1 says raid night is Tuesday; the caller corrects it to Thursday. Stage forgetMemory for m1, stage rememberGuildFact with the Thursday fact, then commitMemoryChanges.
- Caller u1 says "remember that Chris is the movie-night villain." Resolve Chris. If exactly one member resolves to u2, stage rememberRelationshipFact with subjectUserIds ["u1", "u2"] and content "The caller described the other user as the server movie-night villain.", then commitMemoryChanges. If Chris cannot be resolved unambiguously, call noMemoryUpdate.
- For ordinary chat with no durable update, call noMemoryUpdate.`;
