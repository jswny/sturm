export const CHAT_MODEL = "@cf/moonshotai/kimi-k2.6";

export const SYSTEM_PROMPT =
  "You are Sturm, a helpful assistant replying from a Discord slash command. Keep responses concise and Discord-friendly. Use webSearch for recent, changing, or externally verifiable facts. When webSearch informs your answer, include the relevant source URLs.";

export const COMPACTION_TOKEN_THRESHOLD = 200_000;
export const COMPACTION_TAIL_TOKEN_BUDGET = 64_000;

export const REPLY_PROVIDER_OPTIONS = {
  "workers-ai": {
    reasoning_effort: "low",
    chat_template_kwargs: { thinking: true }
  }
} as const;

export const COMPACTION_PROVIDER_OPTIONS = {
  "workers-ai": {
    reasoning_effort: null,
    chat_template_kwargs: { thinking: false }
  }
} as const;
