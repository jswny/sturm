import { createWorkersAI } from "workers-ai-provider";

export const CHAT_MODEL = "@cf/moonshotai/kimi-k2.7-code";
export const REPLY_CHAT_MODEL = "dynamic/sturm-reply";
export const IMAGE_SUMMARY_CHAT_MODEL = REPLY_CHAT_MODEL;
export const COMPACTION_CHAT_MODEL = "dynamic/sturm-compaction";
export const MEMORY_REFLECTION_CHAT_MODEL = "dynamic/sturm-memory-reflection";
export const CHAT_AI_GATEWAY_ID = "default";
export const CHAT_AI_GATEWAY_METADATA = {
  app: "sturm"
};
export const CHAT_AI_GATEWAY_FLOWS = {
  reply: "reply",
  imageSummary: "image-summary",
  compaction: "compaction",
  memoryReflection: "memory-reflection"
} as const;

export type ChatAiGatewayFlow =
  (typeof CHAT_AI_GATEWAY_FLOWS)[keyof typeof CHAT_AI_GATEWAY_FLOWS];
export type ChatAiGatewayCorrelation = {
  correlationId?: string;
  guildId?: string;
  channelId?: string;
};
type ChatAiGatewayMetadata = Record<string, string>;

export const COMPACTION_TOKEN_THRESHOLD = 200_000;
export const COMPACTION_TAIL_TOKEN_BUDGET = 64_000;
export const CONTEXT_OVERFLOW_MAX_INPUT_TOKENS = COMPACTION_TOKEN_THRESHOLD;
export const CONTEXT_OVERFLOW_HEADROOM = 0.9;
export const REPLY_CHAT_TIMEOUT_MS = 120_000;

type WorkersAIProviderOptions = {
  readonly "workers-ai": {
    readonly reasoning_effort?: "low" | "medium" | "high" | null;
    readonly chat_template_kwargs?: {
      readonly thinking?: boolean;
      readonly enable_thinking?: boolean;
      readonly clear_thinking?: boolean;
    };
  };
};

export const REPLY_PROVIDER_OPTIONS = {
  "workers-ai": {
    reasoning_effort: "medium",
    chat_template_kwargs: { thinking: true }
  }
} as const satisfies WorkersAIProviderOptions;

export const COMPACTION_PROVIDER_OPTIONS = {
  "workers-ai": {
    reasoning_effort: null,
    chat_template_kwargs: { thinking: false }
  }
} as const satisfies WorkersAIProviderOptions;

export const IMAGE_SUMMARY_PROVIDER_OPTIONS = {
  "workers-ai": {
    reasoning_effort: null,
    chat_template_kwargs: {
      thinking: false,
      enable_thinking: false,
      clear_thinking: true
    }
  }
} as const satisfies WorkersAIProviderOptions;

export const MEMORY_REFLECTION_PROVIDER_OPTIONS = {
  "workers-ai": {
    reasoning_effort: "low",
    chat_template_kwargs: { thinking: true }
  }
} as const satisfies WorkersAIProviderOptions;

export type ModelProviderOptions =
  | typeof REPLY_PROVIDER_OPTIONS
  | typeof IMAGE_SUMMARY_PROVIDER_OPTIONS
  | typeof COMPACTION_PROVIDER_OPTIONS
  | typeof MEMORY_REFLECTION_PROVIDER_OPTIONS;

export function createChatWorkersAI(
  env: Pick<Env, "AI">,
  flow: ChatAiGatewayFlow,
  correlation: ChatAiGatewayCorrelation = {}
) {
  return createWorkersAI({
    binding: env.AI,
    gateway: {
      id: CHAT_AI_GATEWAY_ID,
      metadata: createChatAiGatewayMetadata(flow, correlation)
    }
  });
}

function createChatAiGatewayMetadata(
  flow: ChatAiGatewayFlow,
  correlation: ChatAiGatewayCorrelation
): ChatAiGatewayMetadata {
  return removeUndefined({
    ...CHAT_AI_GATEWAY_METADATA,
    flow,
    correlationId: correlation.correlationId,
    guildId: correlation.guildId,
    channelId: correlation.channelId
  });
}

function removeUndefined(
  value: Record<string, string | undefined>
): ChatAiGatewayMetadata {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as ChatAiGatewayMetadata;
}
