import { AgentContextProvider } from "agents/experimental/memory/session";
import type { Session, SqlProvider } from "agents/experimental/memory/session";
import { createBaseSystemPrompt, createRuntimeSystemPrompt } from "./prompts";

export const GUILD_MEMORY_CONTEXT_LABEL = "guild_memory";

export const GUILD_MEMORY_CONTEXT_DESCRIPTION =
  "Durable memory shared by Sturm across all channels in this Discord guild. Store concise, stable, reusable guild-level context, including casual server lore, running jokes, and friend-server banter. Store subjective or teasing claims about people as user-provided lore rather than verified facts.";

export const GUILD_MEMORY_CONTEXT_MAX_TOKENS = 2000;

const SESSION_CONTEXT_PROMPT_RENDERER_NAME = "sturm-session-context-prompt";
const SESSION_CONTEXT_PROMPT_STORAGE_KEY = `session-context-prompt:${stableHash(
  JSON.stringify({
    rendererName: SESSION_CONTEXT_PROMPT_RENDERER_NAME,
    contexts: [
      {
        label: GUILD_MEMORY_CONTEXT_LABEL,
        description: GUILD_MEMORY_CONTEXT_DESCRIPTION,
        maxTokens: GUILD_MEMORY_CONTEXT_MAX_TOKENS
      }
    ]
  })
)}`;
const GUILD_MEMORY_PROMPT_VERSION_KEY = "guild-memory-prompt-version";

type VersionedMemoryProvider = {
  getCurrentVersion(): Promise<number>;
  getLastReadVersion(): number | undefined;
};

export function createSessionContextPromptProvider(agent: SqlProvider) {
  return new AgentContextProvider(agent, SESSION_CONTEXT_PROMPT_STORAGE_KEY);
}

export async function getFreshSessionContextPrompt(
  session: Session,
  storage: DurableObjectStorage,
  provider: VersionedMemoryProvider | undefined
) {
  if (!provider) return session.freezeSystemPrompt();

  const currentVersion = await provider.getCurrentVersion();
  const cachedVersion = await storage.get<number>(
    GUILD_MEMORY_PROMPT_VERSION_KEY
  );
  if (cachedVersion === currentVersion) {
    return session.freezeSystemPrompt();
  }

  const prompt = await session.refreshSystemPrompt();
  await storage.put(
    GUILD_MEMORY_PROMPT_VERSION_KEY,
    provider.getLastReadVersion() ?? currentVersion
  );
  return prompt;
}

export function createDiscordThinkSystemPrompt(sessionContext: string) {
  const sections = [createBaseSystemPrompt()];
  const trimmedSessionContext = sessionContext.trim();
  if (trimmedSessionContext) sections.push(trimmedSessionContext);
  sections.push(createRuntimeSystemPrompt());

  return sections.join("\n\n");
}

function stableHash(input: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
