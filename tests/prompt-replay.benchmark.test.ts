import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

type PromptReplayRequest = {
  messages: unknown[];
  tools?: unknown;
  tool_choice?: unknown;
  stream?: unknown;
  [key: string]: unknown;
};

type PromptReplayFixture = {
  model: string;
  runs?: number;
  request: PromptReplayRequest;
  variants?: PromptReplayVariant[];
  scoring?: PromptReplayScoring;
};

type PromptReplayVariant = {
  name: string;
  disableTools?: boolean;
  appendSystem?: string;
  systemReplacements?: { find: string; replace: string }[];
};

type PromptReplayScoring = {
  includeAny?: string[];
  excludeAny?: string[];
};

type AiBinding = {
  run(model: string, input: unknown, options?: unknown): Promise<unknown>;
};

const DEFAULT_RUNS = 10;
const DEFAULT_SCORING: PromptReplayScoring = {};
const PROMPT_REPLAY_ENABLED = process.env.STURM_RUN_PROMPT_REPLAY === "true";
const describePromptReplay = PROMPT_REPLAY_ENABLED ? describe : describe.skip;
const localFixtureModules = (
  import.meta as ImportMeta & {
    glob: (
      pattern: string,
      options: { eager: true; import: "default" }
    ) => Record<string, unknown>;
  }
).glob("./fixtures/prompt-replay/*.local.json", {
  eager: true,
  import: "default"
});

describePromptReplay("prompt replay benchmark", () => {
  const fixtures = Object.entries(localFixtureModules).map(([path, value]) => ({
    path,
    fixture: expectPromptReplayFixture(value, path)
  }));

  it("has at least one local fixture", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { path, fixture } of fixtures) {
    const variants =
      fixture.variants && fixture.variants.length > 0
        ? fixture.variants
        : [{ name: "captured" }];

    for (const variant of variants) {
      it(`${path} :: ${variant.name}`, async () => {
        const summary = await runPromptReplayBenchmark(fixture, variant);
        console.log(JSON.stringify(summary, null, 2));
        expect(summary.completedRuns).toBe(summary.totalRuns);
      }, 240_000);
    }
  }
});

async function runPromptReplayBenchmark(
  fixture: PromptReplayFixture,
  variant: PromptReplayVariant
) {
  const model = fixture.model;
  const runs = fixture.runs ?? DEFAULT_RUNS;
  const scoring = fixture.scoring ?? DEFAULT_SCORING;
  const results: PromptReplayRunResult[] = [];

  for (let run = 1; run <= runs; run++) {
    const input = createReplayInput(fixture.request, variant);
    const result = await (env.AI as AiBinding).run(model, input, {
      gateway: {
        id: "default",
        skipCache: true,
        metadata: {
          app: "sturm",
          flow: "prompt-replay-benchmark",
          fixtureVariant: variant.name
        }
      }
    });
    const text = extractAssistantText(result);
    results.push({
      run,
      finishReason: extractFinishReason(result),
      hasToolCalls: hasToolCalls(result),
      text,
      score: scoreAssistantText(text, scoring)
    });
  }

  const textRuns = results.filter((result) => result.text.length > 0);
  return {
    model,
    variant: variant.name,
    totalRuns: runs,
    completedRuns: results.length,
    textRuns: textRuns.length,
    toolCallRuns: results.filter((result) => result.hasToolCalls).length,
    scorePasses: results.filter((result) => result.score.pass).length,
    includeMisses: results.filter((result) => result.score.includeMiss).length,
    excludeHits: results.filter((result) => result.score.excludeHit).length,
    results
  };
}

function createReplayInput(
  request: PromptReplayRequest,
  variant: PromptReplayVariant
) {
  const input = structuredClone(request);
  input.stream = false;
  if (variant.disableTools) {
    delete input.tools;
    delete input.tool_choice;
  }

  const appendSystem = variant.appendSystem;
  if (appendSystem) {
    input.messages = input.messages.map((message, index) =>
      index === 0 ? appendMessageContent(message, appendSystem) : message
    );
  }

  for (const replacement of variant.systemReplacements ?? []) {
    input.messages = input.messages.map((message, index) =>
      index === 0 ? replaceMessageContent(message, replacement) : message
    );
  }

  return input;
}

function appendMessageContent(message: unknown, suffix: string) {
  if (!isRecord(message) || typeof message.content !== "string") return message;
  return {
    ...message,
    content: `${message.content}\n${suffix}`
  };
}

function replaceMessageContent(
  message: unknown,
  replacement: { find: string; replace: string }
) {
  if (!isRecord(message) || typeof message.content !== "string") return message;
  return {
    ...message,
    content: message.content.replace(replacement.find, replacement.replace)
  };
}

function extractAssistantText(result: unknown) {
  const firstChoice = getFirstChoice(result);
  const message = isRecord(firstChoice?.message) ? firstChoice.message : {};
  const content = message.content;
  return typeof content === "string" ? content : "";
}

function extractFinishReason(result: unknown) {
  const firstChoice = getFirstChoice(result);
  const finishReason = firstChoice?.finish_reason;
  return typeof finishReason === "string" ? finishReason : undefined;
}

function hasToolCalls(result: unknown) {
  const firstChoice = getFirstChoice(result);
  const message = isRecord(firstChoice?.message) ? firstChoice.message : {};
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function getFirstChoice(result: unknown) {
  if (!isRecord(result) || !Array.isArray(result.choices)) return undefined;
  const firstChoice = result.choices[0];
  return isRecord(firstChoice) ? firstChoice : undefined;
}

function scoreAssistantText(text: string, scoring: PromptReplayScoring) {
  const normalized = text.toLowerCase();
  const includeAny = scoring.includeAny ?? [];
  const excludeAny = scoring.excludeAny ?? [];
  const includeMiss =
    includeAny.length > 0 &&
    !includeAny.some((needle) => normalized.includes(needle.toLowerCase()));
  const excludeHit = excludeAny.some((needle) =>
    normalized.includes(needle.toLowerCase())
  );

  return {
    pass: !includeMiss && !excludeHit,
    includeMiss,
    excludeHit
  };
}

function expectPromptReplayFixture(
  value: unknown,
  path: string
): PromptReplayFixture {
  if (!isRecord(value)) throw new Error(`${path} must export a JSON object`);
  if (!isRecord(value.request)) {
    throw new Error(`${path} must include a request object`);
  }
  if (!Array.isArray(value.request.messages)) {
    throw new Error(`${path} request.messages must be an array`);
  }
  if (typeof value.model !== "string" || value.model.length === 0) {
    throw new Error(`${path} must include a model`);
  }
  return value as PromptReplayFixture;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type PromptReplayRunResult = {
  run: number;
  finishReason: string | undefined;
  hasToolCalls: boolean;
  text: string;
  score: {
    pass: boolean;
    includeMiss: boolean;
    excludeHit: boolean;
  };
};
