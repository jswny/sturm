import { createOpenAI } from "@ai-sdk/openai";
import { createGatewayProvider } from "workers-ai-provider/gateway";

export const CHAT_MODEL = "gpt-5.6-sol";
export const IMAGE_GENERATION_MODEL = "google/nano-banana-2";
export const IMAGE_GENERATION_TIMEOUT_MS = 180_000;
export const BROWSER_EXECUTION_TIMEOUT_MS = 60_000;
export const REPLY_CHAT_BASE_TIMEOUT_MS = 120_000;
export const REPLY_CHAT_BLOCKING_OPERATION_TIMEOUT_BUFFER_MS = 15_000;
const REPLY_CHAT_BLOCKING_OPERATION_TIMEOUTS_MS = [
  BROWSER_EXECUTION_TIMEOUT_MS,
  IMAGE_GENERATION_TIMEOUT_MS
] as const;
export const REPLY_CHAT_TIMEOUT_MS = Math.max(
  REPLY_CHAT_BASE_TIMEOUT_MS,
  timeoutWithBuffer(
    REPLY_CHAT_BLOCKING_OPERATION_TIMEOUTS_MS,
    REPLY_CHAT_BLOCKING_OPERATION_TIMEOUT_BUFFER_MS
  )
);
export const CHAT_STREAM_STALL_TIMEOUT_MS = REPLY_CHAT_TIMEOUT_MS;
export const DEFAULT_IMAGE_ASPECT_RATIO = "1:1";
export const IMAGE_GENERATION_OUTPUT_FORMAT = "jpg";
export const DEFAULT_IMAGE_RESOLUTION = "1K";
export const IMAGE_GENERATION_GOOGLE_SEARCH = true;
export const IMAGE_GENERATION_IMAGE_SEARCH = true;
export const CHAT_AI_GATEWAY_ID = "default";
export const CHAT_AI_GATEWAY_METADATA = {
  app: "sturm"
};
export const CHAT_AI_GATEWAY_FLOWS = {
  reply: "reply",
  artifactSummary: "artifact-summary",
  compaction: "compaction",
  memoryReflection: "memory-reflection",
  imageGeneration: "image-generation"
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

type OpenAIProviderOptions = {
  readonly openai: {
    readonly reasoningEffort: "none" | "low" | "medium";
    readonly textVerbosity: "low";
    readonly store: false;
  };
};

export const REPLY_PROVIDER_OPTIONS = {
  openai: {
    reasoningEffort: "medium",
    textVerbosity: "low",
    store: false
  }
} as const satisfies OpenAIProviderOptions;

export const COMPACTION_PROVIDER_OPTIONS = {
  openai: {
    reasoningEffort: "none",
    textVerbosity: "low",
    store: false
  }
} as const satisfies OpenAIProviderOptions;

export const ARTIFACT_SUMMARY_PROVIDER_OPTIONS = {
  openai: {
    reasoningEffort: "none",
    textVerbosity: "low",
    store: false
  }
} as const satisfies OpenAIProviderOptions;

export const MEMORY_REFLECTION_PROVIDER_OPTIONS = {
  openai: {
    reasoningEffort: "low",
    textVerbosity: "low",
    store: false
  }
} as const satisfies OpenAIProviderOptions;

export type ModelProviderOptions =
  | typeof REPLY_PROVIDER_OPTIONS
  | typeof ARTIFACT_SUMMARY_PROVIDER_OPTIONS
  | typeof COMPACTION_PROVIDER_OPTIONS
  | typeof MEMORY_REFLECTION_PROVIDER_OPTIONS;

export function createChatModel(
  env: Pick<Env, "AI">,
  flow: ChatAiGatewayFlow,
  correlation: ChatAiGatewayCorrelation = {},
  sessionAffinity?: string
) {
  const openai = createGatewayProvider(createOpenAI, {
    binding: env.AI,
    gateway: CHAT_AI_GATEWAY_ID,
    byok: false,
    extraHeaders: removeUndefined({
      "cf-aig-metadata": JSON.stringify(
        createChatAiGatewayMetadata(flow, correlation)
      ),
      "cf-aig-request-timeout": String(REPLY_CHAT_BASE_TIMEOUT_MS),
      "x-session-affinity": sessionAffinity
    })
  });
  return openai.responses(CHAT_MODEL);
}

export function createChatAiGatewayMetadata(
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

function timeoutWithBuffer(timeoutsMs: readonly number[], bufferMs: number) {
  return Math.max(0, ...timeoutsMs) + bufferMs;
}
