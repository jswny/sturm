import type { FiberContext } from "@cloudflare/think";
import type { LanguageModel } from "ai";
import { getErrorMessage } from "./logging";
import type { GuildMemoryProvider } from "./memory";
import {
  getGuildMemoryReflectionSummary,
  GuildMemoryReflectionStore,
  reflectGuildMemoryAfterTurn,
  type GuildMemoryReflectionFiberPhase,
  type GuildMemoryReflectionSnapshot,
  type GuildMemoryReflectionSummary
} from "./memory-reflection";
import type { ModelProviderOptions } from "./model";

export type GuildMemoryReflectionRunnerOptions = {
  store: GuildMemoryReflectionStore;
  getProvider(): GuildMemoryProvider;
  createModel(snapshot: GuildMemoryReflectionSnapshot): LanguageModel;
  providerOptions?: ModelProviderOptions;
};

export class GuildMemoryReflectionRunner {
  constructor(private options: GuildMemoryReflectionRunnerOptions) {}

  async run(snapshot: GuildMemoryReflectionSnapshot, fiber?: FiberContext) {
    assertNotAborted(fiber, "before starting");

    const stash = (
      phase: GuildMemoryReflectionFiberPhase,
      reflection?: GuildMemoryReflectionSummary
    ) =>
      fiber?.stash({
        ...snapshot,
        phase,
        reflection
      } satisfies GuildMemoryReflectionSnapshot);

    stash(snapshot.phase, snapshot.reflection);
    const started = await this.options.store.markRunning(
      snapshot.interactionId
    );
    if (!started.started) return null;

    try {
      if (
        (snapshot.phase === "written" || snapshot.phase === "completed") &&
        snapshot.reflection
      ) {
        await this.complete(snapshot.interactionId, snapshot.reflection);
        stash("completed", snapshot.reflection);
        return snapshot.reflection;
      }

      const provider = this.options.getProvider();
      assertNotAborted(fiber, "before reading guild memory");
      const currentMemory = (await provider.get()) ?? "";
      assertNotAborted(fiber, "before reflecting on guild memory");
      const reflection = await reflectGuildMemoryAfterTurn({
        model: this.options.createModel(snapshot),
        currentMemory,
        request: snapshot.request,
        assistantText: snapshot.assistantText,
        providerOptions: this.options.providerOptions
      });
      const reflectionSummary = getGuildMemoryReflectionSummary(reflection);
      stash("reflected", reflectionSummary);

      if (reflection.changed && reflection.nextMemory !== undefined) {
        assertNotAborted(fiber, "before writing guild memory");
        await provider.set(reflection.nextMemory);
        stash("written", reflectionSummary);
      }

      assertNotAborted(fiber, "before completing");
      await this.complete(snapshot.interactionId, reflectionSummary);
      stash("completed", reflectionSummary);
      return reflectionSummary;
    } catch (error) {
      const message = getErrorMessage(error);
      if (error instanceof GuildMemoryReflectionAbortError) {
        await this.options.store.abort(snapshot.interactionId, message);
      } else {
        await this.options.store.fail(snapshot.interactionId, message);
      }
      throw error;
    }
  }

  private async complete(
    interactionId: string,
    reflection: GuildMemoryReflectionSummary
  ) {
    await this.options.store.complete(
      interactionId,
      reflection.changed,
      reflection.operation,
      reflection.attempts
    );
  }
}

class GuildMemoryReflectionAbortError extends Error {
  constructor(stage: string, reason: unknown) {
    const reasonText = getAbortReasonText(reason);
    super(
      reasonText
        ? `Guild memory reflection was canceled ${stage}: ${reasonText}`
        : `Guild memory reflection was canceled ${stage}.`
    );
    this.name = "GuildMemoryReflectionAbortError";
  }
}

function assertNotAborted(fiber: FiberContext | undefined, stage: string) {
  if (!fiber?.signal.aborted) return;
  throw new GuildMemoryReflectionAbortError(stage, fiber.signal.reason);
}

function getAbortReasonText(reason: unknown) {
  if (reason === undefined || reason === null) return "";
  return reason instanceof Error ? reason.message : String(reason);
}
