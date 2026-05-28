export const CHAT_MODEL = "@cf/moonshotai/kimi-k2.6";

export const COMPACTION_TOKEN_THRESHOLD = 200_000;
export const COMPACTION_TAIL_TOKEN_BUDGET = 64_000;

export const REPLY_PROVIDER_OPTIONS = {
  "workers-ai": {
    reasoning_effort: "medium",
    chat_template_kwargs: { thinking: true }
  }
} as const;

export const COMPACTION_PROVIDER_OPTIONS = {
  "workers-ai": {
    reasoning_effort: null,
    chat_template_kwargs: { thinking: false }
  }
} as const;

export const MEMORY_REFLECTION_PROVIDER_OPTIONS = {
  "workers-ai": {
    reasoning_effort: "low",
    chat_template_kwargs: { thinking: true }
  }
} as const;

export type ModelProviderOptions =
  | typeof REPLY_PROVIDER_OPTIONS
  | typeof COMPACTION_PROVIDER_OPTIONS
  | typeof MEMORY_REFLECTION_PROVIDER_OPTIONS;
