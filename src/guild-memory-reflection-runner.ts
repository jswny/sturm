import type { FiberContext } from "@cloudflare/think";
import type { LanguageModel } from "ai";
import { getErrorMessage } from "./logging";
import type { GuildMemoryProvider, GuildMemorySource } from "./memory";
import {
  getGuildMemoryReflectionSummary,
  GuildMemoryReflectionStore,
  reflectGuildMemory,
  type GuildMemoryReflectionFiberPhase,
  type GuildMemoryReflectionSnapshot,
  type GuildMemoryReflectionSummary
} from "./memory-reflection";
import type { ModelProviderOptions } from "./model";
import type { GuildMemberSearchResult } from "./nickname";

const GUILD_MEMORY_COMMIT_ATTEMPTS = 2;

export type GuildMemoryReflectionRunnerOptions = {
  store: GuildMemoryReflectionStore;
  getProvider(): GuildMemoryProvider;
  createModel(snapshot: GuildMemoryReflectionSnapshot): LanguageModel;
  searchGuildMembers?(
    snapshot: GuildMemoryReflectionSnapshot,
    query: string
  ): Promise<GuildMemberSearchResult>;
  assertCanCommit?(snapshot: GuildMemoryReflectionSnapshot): void;
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
      snapshot.correlationId,
      snapshot.discordInteractionId
    );
    if (!started.started) return null;

    try {
      if (
        (snapshot.phase === "written" || snapshot.phase === "completed") &&
        snapshot.reflection
      ) {
        await this.complete(snapshot.correlationId, snapshot.reflection);
        stash("completed", snapshot.reflection);
        return snapshot.reflection;
      }

      const provider = this.options.getProvider();
      const provenance = getMemoryCommitProvenance(snapshot);
      let totalModelAttempts = 0;
      for (
        let commitAttempt = 1;
        commitAttempt <= GUILD_MEMORY_COMMIT_ATTEMPTS;
        commitAttempt++
      ) {
        assertNotAborted(fiber, "before reading guild memory");
        const currentCatalog = await provider.getCatalog();
        assertNotAborted(fiber, "before reflecting on guild memory");
        const plan = await reflectGuildMemory({
          model: this.options.createModel(snapshot),
          currentCatalog,
          evidence: snapshot.evidence,
          searchGuildMembers: this.options.searchGuildMembers
            ? (query) => this.options.searchGuildMembers!(snapshot, query)
            : undefined,
          providerOptions: this.options.providerOptions
        });
        totalModelAttempts += plan.attempts;
        const planWithAttempts = {
          ...plan,
          attempts: totalModelAttempts
        };
        const provisionalSummary =
          getGuildMemoryReflectionSummary(planWithAttempts);
        stash("reflected", provisionalSummary);

        if (plan.decision === "no_change") {
          assertNotAborted(fiber, "before completing");
          await this.complete(snapshot.correlationId, provisionalSummary);
          stash("completed", provisionalSummary);
          return provisionalSummary;
        }

        assertNotAborted(fiber, "before writing guild memory");
        this.options.assertCanCommit?.(snapshot);
        const commit = await provider.commit({
          correlationId: snapshot.correlationId,
          baseEpoch: currentCatalog.epoch,
          ...provenance,
          mutations: plan.mutations
        });
        if (commit.status === "conflict") {
          if (commit.reason === "reset") {
            const resetSummary = {
              changed: false,
              operation: "no_change",
              attempts: totalModelAttempts,
              reason: "guild_memory_reset"
            } satisfies GuildMemoryReflectionSummary;
            await this.complete(snapshot.correlationId, resetSummary);
            stash("completed", resetSummary);
            return resetSummary;
          }

          if (commitAttempt < GUILD_MEMORY_COMMIT_ATTEMPTS) continue;
          throw new Error(
            `Guild memory changed while reflection was running. Missing memory IDs: ${commit.missingMemoryIds?.join(", ") ?? "unknown"}.`
          );
        }

        const committedSummary = getGuildMemoryReflectionSummary(
          planWithAttempts,
          commit
        );
        stash("written", committedSummary);
        assertNotAborted(fiber, "before completing");
        await this.complete(snapshot.correlationId, committedSummary);
        stash("completed", committedSummary);
        return committedSummary;
      }

      throw new Error("Guild memory reflection exhausted commit attempts.");
    } catch (error) {
      const message = getErrorMessage(error);
      if (error instanceof GuildMemoryReflectionAbortError) {
        await this.options.store.abort(snapshot.correlationId, message);
      } else {
        await this.options.store.fail(snapshot.correlationId, message);
      }
      throw error;
    }
  }

  private async complete(
    correlationId: string,
    reflection: GuildMemoryReflectionSummary
  ) {
    await this.options.store.complete(correlationId, reflection);
  }
}

function getMemoryCommitProvenance(snapshot: GuildMemoryReflectionSnapshot): {
  source: GuildMemorySource;
  assertedByUserId?: string;
} {
  switch (snapshot.evidence.kind) {
    case "completed_turn": {
      const assertedByUserId =
        snapshot.evidence.request.user?.id ?? snapshot.evidence.request.userId;
      if (!assertedByUserId) {
        throw new Error(
          "Completed-turn guild memory reflection cannot commit without a Discord caller user ID."
        );
      }
      return { source: "discord_turn", assertedByUserId };
    }
    case "ambient_batch":
      return { source: "ambient_channel" };
    default:
      return assertNever(snapshot.evidence);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported guild memory evidence: ${String(value)}`);
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
