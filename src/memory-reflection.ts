import { generateText, tool, type LanguageModel } from "ai";
import { z } from "zod";
import type { DiscordChatRequest } from "./discord/types";
import {
  MEMORY_REFLECTION_PROVIDER_OPTIONS,
  type ModelProviderOptions
} from "./model";

const GUILD_MEMORY_REFLECTION_PREFIX = "guild-memory-reflection:";
const MEMORY_REFLECTION_RECORD_PRUNE_BATCH_SIZE = 100;
const MEMORY_REFLECTION_MODEL_ATTEMPTS = 2;

const appendGuildMemoryInputSchema = z.object({
  memories: z
    .array(z.string().min(1))
    .min(1)
    .describe("Concise complete memory entries to append.")
});

const replaceGuildMemoryInputSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe(
      "The complete replacement guild_memory text, preserving unrelated existing entries."
    )
});

const noMemoryUpdateInputSchema = z.object({});

export type GuildMemoryReflectionOperation = "no_change" | "append" | "replace";

export type GuildMemoryReflectionDecision = {
  appendMemories: string[];
  replaceMemory?: string;
};

export type GuildMemoryReflectionRecord = {
  interactionId: string;
  status: "running" | "completed" | "failed" | "aborted";
  createdAt: string;
  updatedAt: string;
  changed?: boolean;
  operation?: GuildMemoryReflectionOperation;
  attempts?: number;
  error?: string;
};

export type GuildMemoryReflectionResult = {
  changed: boolean;
  operation: GuildMemoryReflectionOperation;
  nextMemory?: string;
  reason?: string;
  attempts?: number;
};

export type GuildMemoryReflectionSummary = Pick<
  GuildMemoryReflectionResult,
  "changed" | "operation" | "reason" | "attempts"
>;

export type GuildMemoryReflectionFiberPhase =
  | "input"
  | "reflected"
  | "written"
  | "completed";

export type GuildMemoryReflectionSnapshot = {
  kind: "guild_memory_reflection";
  version: 1;
  phase: GuildMemoryReflectionFiberPhase;
  interactionId: string;
  request: DiscordChatRequest;
  assistantText: string;
  reflection?: GuildMemoryReflectionSummary;
};

export type ReflectGuildMemoryInput = {
  model: LanguageModel;
  currentMemory: string;
  request: DiscordChatRequest;
  assistantText: string;
  providerOptions?: ModelProviderOptions;
};

export class GuildMemoryReflectionStore {
  constructor(private storage: DurableObjectStorage) {}

  async get(interactionId: string) {
    return this.storage.get<GuildMemoryReflectionRecord>(
      getMemoryReflectionRecordKey(interactionId)
    );
  }

  async markRunning(interactionId: string) {
    const now = new Date().toISOString();
    return this.storage.transaction(async (txn) => {
      const key = getMemoryReflectionRecordKey(interactionId);
      const existing = await txn.get<GuildMemoryReflectionRecord>(key);
      if (existing?.status === "completed") {
        return { started: false, record: existing };
      }

      const record = {
        interactionId,
        status: "running",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      } satisfies GuildMemoryReflectionRecord;
      await txn.put(key, record);
      return { started: true, record };
    });
  }

  async complete(
    interactionId: string,
    changed: boolean,
    operation: GuildMemoryReflectionOperation,
    attempts: number | undefined
  ) {
    await this.writeTerminalRecord(interactionId, {
      status: "completed",
      changed,
      operation,
      attempts
    });
  }

  async fail(interactionId: string, error: string) {
    await this.writeTerminalRecord(interactionId, {
      status: "failed",
      error
    });
  }

  async abort(interactionId: string, error: string) {
    await this.writeTerminalRecord(interactionId, {
      status: "aborted",
      error
    });
  }

  async pruneTerminalRecords(retentionMs: number) {
    const cutoffMs = Date.now() - retentionMs;
    const records = await this.storage.list<GuildMemoryReflectionRecord>({
      prefix: GUILD_MEMORY_REFLECTION_PREFIX,
      limit: MEMORY_REFLECTION_RECORD_PRUNE_BATCH_SIZE
    });
    const keysToDelete: string[] = [];

    for (const [key, record] of records) {
      const updatedAtMs = Date.parse(record.updatedAt);
      if (!Number.isFinite(updatedAtMs)) continue;
      if (record.status === "running" && updatedAtMs >= cutoffMs) continue;
      if (updatedAtMs < cutoffMs) keysToDelete.push(key);
    }

    if (keysToDelete.length > 0) {
      await this.storage.delete(keysToDelete);
    }

    return keysToDelete.length;
  }

  private async writeTerminalRecord(
    interactionId: string,
    update: Pick<GuildMemoryReflectionRecord, "status"> &
      Partial<GuildMemoryReflectionRecord>
  ) {
    const now = new Date().toISOString();
    const key = getMemoryReflectionRecordKey(interactionId);
    const existing = await this.storage.get<GuildMemoryReflectionRecord>(key);
    await this.storage.put<GuildMemoryReflectionRecord>(key, {
      interactionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...update
    } as GuildMemoryReflectionRecord);
  }
}

export async function reflectGuildMemoryAfterTurn(
  input: ReflectGuildMemoryInput
): Promise<GuildMemoryReflectionResult> {
  let lastError: unknown;

  for (
    let attempt = 1;
    attempt <= MEMORY_REFLECTION_MODEL_ATTEMPTS;
    attempt++
  ) {
    try {
      const decision = await generateMemoryReflectionDecision(input);
      return withReflectionAttempts(
        applyGuildMemoryReflectionDecision(input.currentMemory, decision),
        attempt
      );
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Guild memory reflection failed.");
}

export function applyGuildMemoryReflectionDecision(
  currentMemory: string,
  decision: GuildMemoryReflectionDecision
): GuildMemoryReflectionResult {
  const current = normalizeMemory(currentMemory);
  const replacement = normalizeMemory(decision.replaceMemory ?? "");

  if (replacement) {
    return {
      changed: replacement !== current,
      operation: "replace",
      nextMemory: replacement
    };
  }

  const entries = getAppendMemoryEntries(decision);
  if (entries.length > 0) {
    const newEntries = entries.filter((entry) => !current.includes(entry));
    if (newEntries.length > 0) {
      const appended = newEntries.join("\n");
      const nextMemory = current ? `${current}\n${appended}` : appended;
      return {
        changed: nextMemory !== current,
        operation: "append",
        nextMemory
      };
    }
  }

  return {
    changed: false,
    operation: "no_change"
  };
}

export function getGuildMemoryReflectionFiberName(interactionId: string) {
  return `${GUILD_MEMORY_REFLECTION_PREFIX}${interactionId}`;
}

export function getGuildMemoryReflectionInteractionId(name: string) {
  if (!name.startsWith(GUILD_MEMORY_REFLECTION_PREFIX)) return undefined;
  const interactionId = name.slice(GUILD_MEMORY_REFLECTION_PREFIX.length);
  return interactionId || undefined;
}

export function createGuildMemoryReflectionSnapshot(
  request: DiscordChatRequest,
  assistantText: string
): GuildMemoryReflectionSnapshot {
  return {
    kind: "guild_memory_reflection",
    version: 1,
    phase: "input",
    interactionId: request.interactionId,
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
  if (typeof value.interactionId !== "string") return null;
  if (typeof value.assistantText !== "string") return null;
  if (!isObject(value.request)) return null;
  if (typeof value.request.interactionId !== "string") return null;
  if (typeof value.request.text !== "string") return null;

  const reflection = parseGuildMemoryReflectionSummary(value.reflection);
  if (value.reflection !== undefined && !reflection) return null;

  return {
    kind: "guild_memory_reflection",
    version: 1,
    phase: value.phase,
    interactionId: value.interactionId,
    request: value.request as DiscordChatRequest,
    assistantText: value.assistantText,
    ...(reflection ? { reflection } : {})
  };
}

export function getGuildMemoryReflectionSummary(
  reflection: GuildMemoryReflectionResult
): GuildMemoryReflectionSummary {
  return {
    changed: reflection.changed,
    operation: reflection.operation,
    ...(reflection.reason ? { reason: reflection.reason } : {}),
    ...(reflection.attempts !== undefined
      ? { attempts: reflection.attempts }
      : {})
  };
}

async function generateMemoryReflectionDecision(
  input: ReflectGuildMemoryInput
) {
  const decisions: GuildMemoryReflectionDecision[] = [];
  const recordDecision = (decision: GuildMemoryReflectionDecision) => {
    decisions.push(decision);
  };

  await generateText({
    model: input.model,
    system: MEMORY_REFLECTION_SYSTEM_PROMPT,
    prompt: createMemoryReflectionPrompt(input),
    tools: createMemoryReflectionTools(input.currentMemory, recordDecision),
    toolChoice: "required",
    providerOptions: input.providerOptions ?? MEMORY_REFLECTION_PROVIDER_OPTIONS
  });

  if (decisions.length !== 1) {
    throw new Error(
      `Guild memory reflection expected exactly one tool call, received ${decisions.length}.`
    );
  }

  return decisions[0];
}

function createMemoryReflectionTools(
  currentMemory: string,
  recordDecision: (decision: GuildMemoryReflectionDecision) => void
) {
  const baseTools = {
    appendGuildMemory: tool({
      description:
        "Append new durable guild memory entries. Use this for explicit remember requests and new stable facts not already present.",
      inputSchema: appendGuildMemoryInputSchema,
      execute: ({ memories }) => {
        recordDecision({ appendMemories: memories });
        return "Memory append proposal recorded.";
      }
    }),
    noMemoryUpdate: tool({
      description:
        "Record that this turn should not change guild memory because it is ordinary chat, excluded, transient, or already present.",
      inputSchema: noMemoryUpdateInputSchema,
      execute: () => {
        recordDecision({ appendMemories: [] });
        return "No guild memory update recorded.";
      }
    })
  };

  if (!normalizeMemory(currentMemory)) return baseTools;

  return {
    ...baseTools,
    replaceGuildMemory: tool({
      description:
        "Replace the complete guild_memory text to correct, update, consolidate, or remove existing memory. Preserve unrelated existing entries. Never write placeholders like old, current, or unchanged.",
      inputSchema: replaceGuildMemoryInputSchema,
      execute: ({ content }) => {
        recordDecision({ appendMemories: [], replaceMemory: content });
        return "Memory replacement proposal recorded.";
      }
    })
  };
}

function createMemoryReflectionPrompt(input: ReflectGuildMemoryInput) {
  return [
    "Current guild_memory:",
    fence(input.currentMemory || "(empty)"),
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

function fence(value: string) {
  return `<content>\n${value}\n</content>`;
}

function truncateForReflection(value: string, maxLength = 4000) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}\n[truncated]`;
}

function normalizeMemory(content: string) {
  return content.trim();
}

function withReflectionAttempts(
  result: GuildMemoryReflectionResult,
  attempts: number
) {
  return {
    ...result,
    attempts
  } satisfies GuildMemoryReflectionResult;
}

function getAppendMemoryEntries(decision: GuildMemoryReflectionDecision) {
  return decision.appendMemories
    .map((entry) => normalizeMemory(entry))
    .filter((entry) => entry.length > 0);
}

function getMemoryReflectionRecordKey(interactionId: string) {
  return `${GUILD_MEMORY_REFLECTION_PREFIX}${interactionId}`;
}

function parseGuildMemoryReflectionSummary(value: unknown) {
  if (value === undefined) return undefined;
  if (!isObject(value)) return null;
  if (typeof value.changed !== "boolean") return null;

  const operation = parseGuildMemoryReflectionOperation(value.operation);
  if (!operation) return null;
  if (value.reason !== undefined && typeof value.reason !== "string") {
    return null;
  }
  if (value.attempts !== undefined && typeof value.attempts !== "number") {
    return null;
  }

  return {
    changed: value.changed,
    operation,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.attempts === "number" ? { attempts: value.attempts } : {})
  } satisfies GuildMemoryReflectionSummary;
}

function parseGuildMemoryReflectionOperation(
  value: unknown
): GuildMemoryReflectionOperation | null {
  if (value === "no_change" || value === "append" || value === "replace") {
    return value;
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

const MEMORY_REFLECTION_SYSTEM_PROMPT = `You are Sturm's private guild memory extractor. The main assistant has already replied to the Discord user. Extract durable guild_memory updates for future turns.

guild_memory is concise, durable context shared across channels in one Discord guild. It should contain stable preferences, personal settings, identities, aliases, server conventions, server lore, running jokes, and durable facts that will likely help future turns.

Call exactly one memory decision tool. Use noMemoryUpdate for ordinary chat. An explicit request to remember, store, keep in mind, or use a fact later is not ordinary chat. For those turns, call appendGuildMemory with one or more entries unless the requested content is excluded below or already present in current guild_memory. If the assistant acknowledged remembering a user-provided fact, treat that as confirmation that an update is needed; do not assume the assistant response already persisted the memory.

Do not skip a memory update because the fact is mundane, playful, synthetic-looking, test data, or phrased as a guild motto, inside joke, nickname, preference, or casual server lore. The user's request to remember is the durable signal. This includes low-sensitivity user-specific facts volunteered in the chat.

Do not store one-off requests, transient task details, secrets, private or high-sensitivity personal data, channel-local state, facts from other guilds, or assistant guesses. Do not treat ordinary volunteered preferences, aliases, time zones, casual server lore, or friend-server banter as sensitive by default. Store subjective or teasing claims about people only as user-provided lore, not verified facts.

Use appendGuildMemory for new durable facts that are not already present. Each entry must be complete and independently understandable. Use replaceGuildMemory only to correct, update, consolidate, or remove existing memory. When replacing, pass the complete new guild_memory text and preserve unrelated existing entries. Do not rewrite memory just for style. If memory is user-specific, include the Discord user ID. If memory is guild-wide, write it as guild-wide. Normalize clear aliases into concise future-useful wording.

Examples:
- User u1 says "please remember that my favorite color is green" and the assistant says it will remember. Call appendGuildMemory with memories ["User u1's favorite color is green."].
- User u1 says "please remember that the guild test motto is silver sunrise" and the assistant says it will remember. Call appendGuildMemory with memories ["The guild test motto is silver sunrise."].
- User u1 says "remember that Chris is the server movie-night villain" and the assistant says it will remember. Call appendGuildMemory with memories ["User u1 said that Chris is the server movie-night villain."]. This records user-provided server lore, not a verified fact.
- Existing memory says "The guild raid night is Tuesday." User says "Actually, update that: the guild raid night is Thursday." Call replaceGuildMemory with content "The guild raid night is Thursday.".
- User u1 asks "what is 2 + 2?" and the assistant answers. Call noMemoryUpdate.

For no change, call noMemoryUpdate.`;
