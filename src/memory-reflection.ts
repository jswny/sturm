import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import type { DiscordChatRequest } from "./discord/types";
import {
  MEMORY_REFLECTION_PROVIDER_OPTIONS,
  type ModelProviderOptions
} from "./model";

const MEMORY_REFLECTION_RECORD_PREFIX = "guild-memory-reflection:";
const MEMORY_REFLECTION_RECORD_PRUNE_BATCH_SIZE = 100;
const MEMORY_REFLECTION_MODEL_ATTEMPTS = 2;

const memoryReflectionDecisionSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("no_change"),
    reason: z.string().optional().describe("Brief reason for the decision.")
  }),
  z.object({
    operation: z.literal("append"),
    memories: z
      .array(z.string().min(1))
      .min(1)
      .describe("Concise complete memory entries to add."),
    reason: z.string().optional().describe("Brief reason for the decision.")
  }),
  z.object({
    operation: z.literal("replace"),
    content: z
      .string()
      .min(1)
      .describe("The complete replacement guild_memory text."),
    reason: z.string().optional().describe("Brief reason for the decision.")
  })
]);

export type GuildMemoryReflectionDecision = z.infer<
  typeof memoryReflectionDecisionSchema
>;

export type GuildMemoryReflectionRecord = {
  interactionId: string;
  status: "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  changed?: boolean;
  operation?: GuildMemoryReflectionDecision["operation"];
  attempts?: number;
  error?: string;
};

export type GuildMemoryReflectionResult = {
  changed: boolean;
  operation: GuildMemoryReflectionDecision["operation"];
  nextMemory?: string;
  reason?: string;
  attempts?: number;
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
    operation: GuildMemoryReflectionDecision["operation"],
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

  async pruneTerminalRecords(retentionMs: number) {
    const cutoffMs = Date.now() - retentionMs;
    const records = await this.storage.list<GuildMemoryReflectionRecord>({
      prefix: MEMORY_REFLECTION_RECORD_PREFIX,
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
  const operation = decision.operation;
  const current = normalizeMemory(currentMemory);

  if (operation === "no_change") {
    return {
      changed: false,
      operation,
      reason: decision.reason
    };
  }

  if (operation === "append") {
    const entries = getAppendMemoryEntries(decision);
    if (entries.length === 0) {
      return {
        changed: false,
        operation,
        reason: decision.reason
      };
    }

    const newEntries = entries.filter((entry) => !current.includes(entry));
    if (newEntries.length === 0) {
      return {
        changed: false,
        operation,
        reason: decision.reason
      };
    }

    const appended = newEntries.join("\n");
    const nextMemory = current ? `${current}\n${appended}` : appended;
    return {
      changed: nextMemory !== current,
      operation,
      nextMemory,
      reason: decision.reason
    };
  }

  const content = normalizeMemory(decision.content ?? "");
  if (!content) {
    return {
      changed: false,
      operation,
      reason: decision.reason
    };
  }

  return {
    changed: content !== current,
    operation,
    nextMemory: content,
    reason: decision.reason
  };
}

async function generateMemoryReflectionDecision(
  input: ReflectGuildMemoryInput
) {
  const result = await generateText({
    model: input.model,
    system: MEMORY_REFLECTION_SYSTEM_PROMPT,
    prompt: createMemoryReflectionPrompt(input),
    output: Output.object({
      schema: memoryReflectionDecisionSchema,
      name: "GuildMemoryReflection",
      description: "A concise decision about whether to update guild memory"
    }),
    providerOptions: input.providerOptions ?? MEMORY_REFLECTION_PROVIDER_OPTIONS
  });

  return result.output;
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
  if (decision.operation !== "append") return [];

  const memories = decision.memories
    ?.map((entry) => normalizeMemory(entry))
    .filter((entry) => entry.length > 0);
  return memories ?? [];
}

function getMemoryReflectionRecordKey(interactionId: string) {
  return `${MEMORY_REFLECTION_RECORD_PREFIX}${interactionId}`;
}

const MEMORY_REFLECTION_SYSTEM_PROMPT = `You are Sturm's private guild memory extractor. The main assistant has already replied to the Discord user. Extract durable guild_memory updates for future turns.

guild_memory is concise, durable context shared across channels in one Discord guild. It should contain stable preferences, personal settings, identities, aliases, server conventions, server lore, running jokes, and durable facts that will likely help future turns.

Prefer no_change for ordinary chat. When the user explicitly asks Sturm to remember a stable fact, or states a reusable preference, identity, alias, personal setting, or server convention, extract a memory update unless it is excluded below. If the assistant acknowledged remembering a stable user-provided fact, you must extract a memory update unless the fact is excluded below. This includes low-sensitivity user-specific facts volunteered in the chat.

Do not store one-off requests, transient task details, secrets, private or high-sensitivity personal data, channel-local state, facts from other guilds, or assistant guesses. Do not treat ordinary volunteered preferences, aliases, time zones, casual server lore, or friend-server banter as sensitive by default. Store subjective or teasing claims about people only as user-provided lore, not verified facts.

Use append for new durable facts that are not already present. For append, return one or more complete memory entries in memories. Use replace only to correct, update, consolidate, or remove existing memory. Do not rewrite memory just for style. If memory is user-specific, include the Discord user ID. Normalize clear aliases into concise future-useful wording.

Examples:
- User u1 says "please remember that my favorite color is green" and the assistant says it will remember. Return append with memories ["User u1's favorite color is green."].
- User u1 asks "what is 2 + 2?" and the assistant answers. Return no_change.

For replace, content must contain the complete new guild_memory. For no_change, omit memories and content.`;
