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
  createModel(): LanguageModel;
  providerOptions?: ModelProviderOptions;
};

export class GuildMemoryReflectionRunner {
  constructor(private options: GuildMemoryReflectionRunnerOptions) {}

  async run(snapshot: GuildMemoryReflectionSnapshot, fiber?: FiberContext) {
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
      const currentMemory = (await provider.get()) ?? "";
      const reflection = await reflectGuildMemoryAfterTurn({
        model: this.options.createModel(),
        currentMemory,
        request: snapshot.request,
        assistantText: snapshot.assistantText,
        providerOptions: this.options.providerOptions
      });
      const reflectionSummary = getGuildMemoryReflectionSummary(reflection);
      stash("reflected", reflectionSummary);

      if (reflection.changed && reflection.nextMemory !== undefined) {
        await provider.set(reflection.nextMemory);
        stash("written", reflectionSummary);
      }

      await this.complete(snapshot.interactionId, reflectionSummary);
      stash("completed", reflectionSummary);
      return reflectionSummary;
    } catch (error) {
      await this.options.store.fail(
        snapshot.interactionId,
        getErrorMessage(error)
      );
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
