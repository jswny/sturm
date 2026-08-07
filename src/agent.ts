import {
  Think,
  type ChatRecoveryContext,
  type ChatRecoveryExhaustedContext,
  type ChatRecoveryOptions,
  type ChatResponseResult,
  type FiberRecoveryContext,
  type PrepareStepContext,
  type StepContext,
  type ThinkSubmissionInspection,
  type TurnConfig,
  type TurnContext
} from "@cloudflare/think";
import { Workspace } from "@cloudflare/shell";
import {
  isPlatformTransientError,
  type FiberInspection,
  type FiberRecoveryResult
} from "agents";
import { Session } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { generateText, type ToolSet } from "ai";
import type { StoredResponseArtifact } from "./artifacts";
import { createChannelScheduledTaskController } from "./channel-scheduler";
import { createRecentDiscordChannelContext } from "./discord/channel-context";
import { freezeDiscordRequestAttachments } from "./discord/attachment-artifacts";
import {
  DiscordComponentPromptStore,
  type DiscordComponentPromptInteractionInput,
  type StoredComponentPrompt
} from "./discord/component-prompts";
import { summarizeDiscordArtifacts } from "./discord/artifact-summaries";
import { formatDiscordRuntimeContext } from "./discord/context";
import { getGuildIdFromDiscordConversationName } from "./discord/conversation";
import { addCurrentTurnImagesToModelMessages } from "./discord/current-turn-images";
import {
  DiscordDeliveryStore,
  getDeliveryCorrelationId,
  isTerminalDelivery,
  type DiscordChatDeliveryRecord,
  type DiscordDeliveryChatInput,
  type DiscordDeliveryRecord,
  type DiscordDeliveryResetInput
} from "./discord/delivery";
import { DiscordDeliveryRunner } from "./discord/delivery-runner";
import {
  createCompletedDiscordDeliveryFiberSnapshot,
  createDiscordDeliveryFiberMetadata,
  createDiscordDeliveryFiberSnapshot,
  createFailedDiscordDeliveryFiberSnapshot,
  getDiscordDeliveryFiberCorrelationId,
  getDiscordDeliveryFiberName,
  parseDiscordDeliveryFiberSnapshot,
  type DiscordDeliveryFiberSnapshot
} from "./discord/delivery-fiber";
import { inlineDataUrls } from "./discord/format";
import { getCurrentBotUser } from "./discord/api";
import {
  createDiscordProgressReporter,
  withProgressTools
} from "./discord/progress";
import type { DiscordProgressReporter } from "./discord/progress";
import { createDiscordSourceTurnContext } from "./discord/source-context";
import {
  clearDiscordSession,
  createDiscordUserMessage,
  getDiscordArtifactsFromAssistantMessage,
  getDiscordTurnFromUserMessage,
  getDiscordMessageText
} from "./discord/turn";
import type { DiscordChatRequest, DiscordChatResponse } from "./discord/types";
import { GuildMemoryReflectionRunner } from "./guild-memory-reflection-runner";
import { getErrorMessage, logError, logInfo, logWarn } from "./logging";
import { GuildMemoryProvider } from "./memory";
import { stripModelThinkingTraces } from "./model-output";
import {
  createGuildMemoryReflectionSnapshot,
  getGuildMemoryReflectionCorrelationId,
  getGuildMemoryReflectionFiberName,
  GuildMemoryReflectionStore,
  parseGuildMemoryReflectionSnapshot,
  type GuildMemoryReflectionRecord
} from "./memory-reflection";
import {
  CHAT_STREAM_STALL_TIMEOUT_MS,
  COMPACTION_PROVIDER_OPTIONS,
  COMPACTION_TAIL_TOKEN_BUDGET,
  COMPACTION_TOKEN_THRESHOLD,
  CONTEXT_OVERFLOW_HEADROOM,
  CONTEXT_OVERFLOW_MAX_INPUT_TOKENS,
  CHAT_AI_GATEWAY_FLOWS,
  type ChatAiGatewayCorrelation,
  createChatModel,
  MEMORY_REFLECTION_PROVIDER_OPTIONS,
  REPLY_PROVIDER_OPTIONS,
  SCHEDULED_CHAT_MAX_RETRIES
} from "./model";
import { createBaseSystemPrompt } from "./prompts";
import {
  createScheduledChannelTaskUserText,
  getScheduledChannelTaskPayload,
  SCHEDULED_CHANNEL_TASK_CALLBACK,
  type ScheduledChannelTaskSchedule,
  type ScheduledChannelTaskPayload
} from "./scheduled-tasks";
import {
  createDiscordThinkSystemPrompt,
  createSessionContextPromptProvider,
  getFreshSessionContextPrompt,
  GUILD_MEMORY_CONTEXT_DESCRIPTION,
  GUILD_MEMORY_CONTEXT_LABEL,
  GUILD_MEMORY_CONTEXT_MAX_TOKENS
} from "./session-context";
import { createBrowserAutomationTools, createDiscordTools } from "./tools";
import type { UserPromptController } from "./tools/user-prompts";

const HOUSEKEEPING_INTERVAL_SECONDS = 24 * 60 * 60;
const TERMINAL_SUBMISSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DISCORD_ADMISSION_RECONCILIATION_LIMIT = 100;
const CHAT_RECOVERY_MAX_ATTEMPTS = 6;
const CHAT_RECOVERY_STABLE_TIMEOUT_MS = 10_000;
const CHAT_RECOVERY_TERMINAL_MESSAGE =
  "Sorry, this request was interrupted and could not be recovered. Please try again.";
const DISCORD_BOT_USER_ID_STORAGE_KEY = "discord:bot-user-id";

type ScheduledChannelTaskExecution = Pick<
  ScheduledChannelTaskSchedule,
  "id" | "time" | "type"
>;

type DiscordAdmissionReconciliationResult = {
  deliveriesInspected: number;
  missingSubmissionsRepaired: number;
  pendingSubmissionsRearmed: number;
  terminalDeliveriesResumed: number;
  submissionsWithoutDeliveries: number;
  reconciliationFailures: number;
};

type DiscordComponentContinuationReconciliationResult = {
  continuationsInspected: number;
  continuationsSubmitted: number;
  continuationFailures: number;
};

export class ChatAgent extends Think<Env> {
  override sendReasoning = false;
  // Keep overflow handling proactive-only so it cannot restart a turn and
  // re-issue mutating Discord tools after a provider context error.
  override contextOverflow = {
    proactive: {
      maxInputTokens: CONTEXT_OVERFLOW_MAX_INPUT_TOKENS,
      headroom: CONTEXT_OVERFLOW_HEADROOM
    }
  };
  override chatRecovery = {
    maxAttempts: CHAT_RECOVERY_MAX_ATTEMPTS,
    stableTimeoutMs: CHAT_RECOVERY_STABLE_TIMEOUT_MS,
    terminalMessage: CHAT_RECOVERY_TERMINAL_MESSAGE,
    onExhausted: (ctx: ChatRecoveryExhaustedContext) =>
      this.handleChatRecoveryExhausted(ctx)
  };
  override chatStreamStallTimeoutMs = CHAT_STREAM_STALL_TIMEOUT_MS;
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "discord_workspace",
    name: () => this.name
  });

  private discordDeliveries = new DiscordDeliveryStore(this.ctx.storage);
  private componentPrompts = new DiscordComponentPromptStore(this.ctx.storage);
  private memoryReflections = new GuildMemoryReflectionStore(this.ctx.storage);
  private progressReporters = new Map<string, DiscordProgressReporter>();
  private artifactSummaryPromises = new Map<
    string,
    Promise<DiscordChatRequest | undefined>
  >();
  private guildMemoryProvider?: GuildMemoryProvider;
  private botUserId?: string;
  private botUserIdPromise?: Promise<string | undefined>;

  override getModel() {
    const turn = this.getLatestDiscordTurn();
    return createChatModel(
      this.env,
      CHAT_AI_GATEWAY_FLOWS.reply,
      createChatAiGatewayCorrelation(turn),
      this.sessionAffinity
    );
  }

  override getSystemPrompt() {
    return createBaseSystemPrompt();
  }

  override configureSession(session: Session) {
    this.guildMemoryProvider = new GuildMemoryProvider(
      this.env.GuildMemory,
      () => getGuildIdFromDiscordConversationName(this.name)
    );

    return session
      .withContext(GUILD_MEMORY_CONTEXT_LABEL, {
        description: GUILD_MEMORY_CONTEXT_DESCRIPTION,
        maxTokens: GUILD_MEMORY_CONTEXT_MAX_TOKENS,
        provider: {
          get: () => this.guildMemoryProvider?.get() ?? Promise.resolve(null)
        }
      })
      .withCachedPrompt(createSessionContextPromptProvider(this))
      .onCompaction(
        createCompactFunction({
          summarize: async (prompt) => {
            const turn = this.getLatestDiscordTurn();
            const model = createChatModel(
              this.env,
              CHAT_AI_GATEWAY_FLOWS.compaction,
              createChatAiGatewayCorrelation(turn),
              this.sessionAffinity
            );
            const result = await generateText({
              model,
              providerOptions: COMPACTION_PROVIDER_OPTIONS,
              system:
                "Summarize Discord conversation history for future assistant context. Preserve factual details, user preferences, decisions, current state, and open items.",
              prompt
            });
            return stripModelThinkingTraces(result.text);
          },
          protectHead: 2,
          tailTokenBudget: COMPACTION_TAIL_TOKEN_BUDGET,
          minTailMessages: 6
        })
      )
      .compactAfter(COMPACTION_TOKEN_THRESHOLD);
  }

  override async onStart(props?: Record<string, unknown>) {
    await super.onStart(props);
    try {
      await this.scheduleEvery(HOUSEKEEPING_INTERVAL_SECONDS, "housekeeping");
    } catch (error) {
      logError("Discord housekeeping schedule registration failed", error, {
        agentName: this.name
      });
    }

    await this.reconcileDiscordAdmissionsSafely("on_start");
    await this.reconcileComponentPromptContinuationsSafely("on_start");
  }

  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig> {
    const turn = this.getLatestDiscordTurn();
    const progress = turn
      ? await this.getOrCreateProgressReporter(turn.correlationId)
      : undefined;
    await progress?.report({
      type: "phase",
      label: "Reading channel context"
    });
    const sessionContext = await getFreshSessionContextPrompt(
      this.session,
      this.ctx.storage,
      this.guildMemoryProvider
    );
    const runtimeContext = turn
      ? await this.createDiscordTurnRuntimeContext(turn)
      : undefined;
    if (turn) this.startArtifactSummaries(turn);
    const tools = await this.createDiscordThinkTools(
      turn,
      progress,
      runtimeContext?.recentChannelBeforeMessageId,
      runtimeContext?.discordBotUserId
    );

    return {
      system: createDiscordThinkSystemPrompt(
        sessionContext,
        runtimeContext?.text
      ),
      messages: inlineDataUrls(
        turn
          ? await addCurrentTurnImagesToModelMessages(ctx.messages, turn, {
              artifactBucket: this.env.ARTIFACTS_BUCKET
            })
          : ctx.messages
      ),
      tools,
      maxSteps: this.maxSteps,
      maxRetries:
        turn?.trigger === "scheduled_channel_task"
          ? SCHEDULED_CHAT_MAX_RETRIES
          : undefined,
      sendReasoning: false,
      providerOptions: REPLY_PROVIDER_OPTIONS as Record<string, unknown>
    };
  }

  override async beforeStep(ctx: PrepareStepContext) {
    const progress = await this.getActiveProgressReporter();
    await progress?.report({
      type: "phase",
      label:
        ctx.stepNumber === 0
          ? "Thinking through the request"
          : "Reviewing tool results"
    });
  }

  override async onStepFinish(ctx: StepContext) {
    const usage = ctx.usage;
    logInfo("Think turn step finished", {
      agentName: this.name,
      finishReason: ctx.finishReason,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      reasoningTokens: usage?.outputTokenDetails.reasoningTokens,
      totalTokens: usage?.totalTokens
    });
  }

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    logWarn("Think chat recovery started", {
      agentName: this.name,
      incidentId: ctx.incidentId,
      requestId: ctx.requestId,
      recoveryRootRequestId: ctx.recoveryRootRequestId,
      attempt: ctx.attempt,
      maxAttempts: ctx.maxAttempts,
      recoveryKind: ctx.recoveryKind,
      streamId: ctx.streamId,
      partialTextLength: ctx.partialText.length,
      createdAt: new Date(ctx.createdAt).toISOString()
    });

    try {
      await this.discordDeliveries.markRecovering(ctx.recoveryRootRequestId);
      await this.reportDiscordRecoveryProgress(ctx.recoveryRootRequestId, {
        type: "phase",
        label: "Recovering interrupted work"
      });
    } catch (error) {
      logWarn("Discord recovery status update failed", {
        agentName: this.name,
        recoveryRootRequestId: ctx.recoveryRootRequestId,
        error: getErrorMessage(error)
      });
    }

    return {};
  }

  override async onChatResponse(result: ChatResponseResult) {
    let record = await this.getDiscordDeliveryForChatResponse(result);
    if (!record || isTerminalDelivery(record)) return;

    if (result.status !== "completed") {
      this.artifactSummaryPromises.delete(getDeliveryCorrelationId(record));
      if (record.type !== "chat") return;
      await this.startDiscordResponseDelivery(
        record,
        createFailedDiscordDeliveryFiberSnapshot(
          record,
          result.error ?? `Think turn ended with status ${result.status}.`
        )
      );
      return;
    }

    try {
      if (record.type !== "chat") return;
      record = await this.applyArtifactSummaries(record);
      await this.startDiscordResponseDelivery(
        record,
        createDiscordDeliveryFiberSnapshot(record, result)
      );
    } finally {
      this.progressReporters.delete(getDeliveryCorrelationId(record));
      this.artifactSummaryPromises.delete(getDeliveryCorrelationId(record));
      await this.housekeeping();
    }
  }

  override async onSubmissionStatus(submission: ThinkSubmissionInspection) {
    const record = await this.discordDeliveries.getDelivery(
      submission.submissionId
    );
    if (!record || isTerminalDelivery(record)) return;

    if (submission.status === "running") {
      await this.discordDeliveries.markRunning(
        getDeliveryCorrelationId(record)
      );
      return;
    }

    if (submission.status === "completed") {
      const deliveryFiber = await this.inspectFiberByKey(
        getDiscordDeliveryFiberName(getDeliveryCorrelationId(record))
      );
      if (
        deliveryFiber?.status === "pending" ||
        deliveryFiber?.status === "running" ||
        deliveryFiber?.status === "interrupted"
      ) {
        return;
      }

      const deliveryRecord =
        record.type === "chat"
          ? await this.applyArtifactSummaries(record)
          : record;
      if (deliveryRecord.type !== "chat") return;
      await this.startDiscordResponseDelivery(
        deliveryRecord,
        createCompletedDiscordDeliveryFiberSnapshot(deliveryRecord)
      );
      return;
    }

    if (
      submission.status === "error" ||
      submission.status === "aborted" ||
      submission.status === "skipped"
    ) {
      const error =
        submission.error ??
        `Think submission ended with status ${submission.status}.`;
      if (record.type !== "chat") return;
      await this.startDiscordResponseDelivery(
        record,
        createFailedDiscordDeliveryFiberSnapshot(
          record,
          error,
          error === CHAT_RECOVERY_TERMINAL_MESSAGE ? error : undefined
        )
      );
    }
  }

  override onChatError(error: unknown) {
    logError("Think chat turn failed", error, {
      agentName: this.name
    });
    return super.onChatError(error);
  }

  override async onFiberRecovered(
    ctx: FiberRecoveryContext
  ): Promise<void | FiberRecoveryResult> {
    const deliveryCorrelationId = getDiscordDeliveryFiberCorrelationId(
      ctx.name
    );
    if (deliveryCorrelationId) {
      return this.recoverDiscordResponseDelivery(ctx, deliveryCorrelationId);
    }

    const correlationId = getGuildMemoryReflectionCorrelationId(ctx.name);
    if (!correlationId) return super.onFiberRecovered(ctx);

    const snapshot = parseGuildMemoryReflectionSnapshot(ctx.snapshot);
    if (!snapshot) {
      const message =
        "Guild memory reflection recovery could not resume without a valid checkpoint.";
      await this.memoryReflections.fail(correlationId, message);
      logWarn(message, {
        agentName: this.name,
        correlationId,
        fiberId: ctx.id,
        fiberName: ctx.name,
        fiberAgeMs: Date.now() - ctx.createdAt
      });
      return { status: "error", error: message };
    }

    try {
      const reflection =
        await this.createGuildMemoryReflectionRunner().run(snapshot);
      if (reflection?.changed) {
        logInfo("Recovered guild memory reflection updated memory", {
          agentName: this.name,
          correlationId,
          operation: reflection.operation,
          attempts: reflection.attempts
        });
      }
      return {
        status: "completed",
        metadata: createGuildMemoryReflectionFiberMetadata(snapshot.request)
      };
    } catch (error) {
      const message = getErrorMessage(error);
      logWarn("Recovered guild memory reflection failed", {
        agentName: this.name,
        correlationId,
        fiberId: ctx.id,
        error: message
      });
      return { status: "error", error: message };
    }
  }

  async enqueueDiscordChat(input: DiscordDeliveryChatInput) {
    const frozenRequest = await freezeDiscordRequestAttachments(
      this.env,
      input.request
    );
    const result = await this.discordDeliveries.create({
      ...input,
      request: frozenRequest
    });
    if (!result.record || result.record.type !== "chat") return;

    const record = result.record;
    if (isTerminalDelivery(record)) return;
    const correlationId = getDeliveryCorrelationId(record);

    if (!result.created) {
      const existingSubmission = await this.inspectSubmission(correlationId);
      if (existingSubmission) {
        if (existingSubmission.status === "pending") {
          await this.submitDiscordChatDelivery(record);
        }
        return;
      }

      logWarn("Repairing pending Discord delivery without Think submission", {
        sequence: record.sequence,
        ...getDeliveryLogContext(record),
        deliveryType: record.type,
        responseTargetType: record.responseTarget.type
      });
    }

    const progress = createDiscordProgressReporter(record.responseTarget, {
      createdAt: record.createdAt,
      correlationId,
      sequence: record.sequence
    });
    if (progress && !this.progressReporters.has(correlationId)) {
      this.progressReporters.set(correlationId, progress);
    }

    try {
      await this.submitDiscordChatDelivery(record);
    } catch (initialError) {
      try {
        const retry = await this.submitDiscordChatDelivery(record);
        logWarn("Recovered Discord Think submission with idempotent retry", {
          sequence: record.sequence,
          ...getDeliveryLogContext(record),
          deliveryType: record.type,
          submissionStatus: retry.status,
          submissionAccepted: retry.accepted,
          initialError: getErrorMessage(initialError)
        });
        return;
      } catch (retryError) {
        let inspectionCompleted = false;
        let persistedSubmission: ThinkSubmissionInspection | null = null;
        try {
          persistedSubmission = await this.inspectSubmission(correlationId);
          inspectionCompleted = true;
        } catch (inspectionError) {
          logWarn(
            "Discord Think submission inspection failed after enqueue error",
            {
              sequence: record.sequence,
              ...getDeliveryLogContext(record),
              deliveryType: record.type,
              initialError: getErrorMessage(initialError),
              retryError: getErrorMessage(retryError),
              inspectionError: getErrorMessage(inspectionError)
            }
          );
        }

        if (persistedSubmission) {
          logWarn(
            "Preserved Discord delivery after Think submission enqueue error",
            {
              sequence: record.sequence,
              ...getDeliveryLogContext(record),
              deliveryType: record.type,
              submissionStatus: persistedSubmission.status,
              initialError: getErrorMessage(initialError),
              retryError: getErrorMessage(retryError)
            }
          );
          return;
        }

        if (result.created && inspectionCompleted) {
          await this.discordDeliveries.deleteCreatedDelivery(record);
        } else if (!inspectionCompleted) {
          logWarn(
            "Preserving Discord delivery because Think acceptance is uncertain",
            {
              sequence: record.sequence,
              ...getDeliveryLogContext(record),
              deliveryType: record.type
            }
          );
        }

        this.progressReporters.delete(correlationId);
        const context = {
          sequence: record.sequence,
          ...getDeliveryLogContext(record),
          deliveryType: record.type,
          initialError: getErrorMessage(initialError)
        };
        if (isPlatformTransientError(retryError)) {
          logWarn("Discord Think submission hit transient platform error", {
            ...context,
            error: getErrorMessage(retryError)
          });
        } else {
          logError("Discord Think submission failed", retryError, context);
        }
        throw retryError;
      }
    }
  }

  async enqueueDiscordReset(input: DiscordDeliveryResetInput) {
    const result = await this.discordDeliveries.create(input);
    if (!result.created || !result.record) return;

    const record = result.record;
    if (record.type !== "reset") {
      throw new Error("Discord reset delivery record had unexpected type.");
    }

    await this.createDiscordDeliveryRunner().processReset(record);
  }

  async runDebugQueuedDiscordChat(
    request: DiscordChatRequest
  ): Promise<DiscordChatResponse> {
    await this.enqueueDiscordChat({
      responseTarget: { type: "debug", id: request.correlationId },
      request
    });
    return this.createDiscordDeliveryRunner().waitForDebugQueuedResponse(
      request.correlationId
    );
  }

  async runDebugQueuedDiscordReset(
    input: Omit<DiscordDeliveryResetInput, "responseTarget">
  ): Promise<DiscordChatResponse> {
    await this.enqueueDiscordReset({
      ...input,
      responseTarget: { type: "debug", id: input.correlationId }
    });
    return this.createDiscordDeliveryRunner().waitForDebugQueuedResponse(
      input.correlationId
    );
  }

  async getDebugDiscordStatus(correlationId: string) {
    const [
      delivery,
      submission,
      deliveryFiber,
      memoryReflection,
      memoryReflectionFiber
    ] = await Promise.all([
      this.discordDeliveries.getDelivery(correlationId),
      this.inspectSubmission(correlationId),
      this.inspectFiberByKey(getDiscordDeliveryFiberName(correlationId)),
      this.memoryReflections.get(correlationId),
      this.inspectFiberByKey(getGuildMemoryReflectionFiberName(correlationId))
    ]);

    return {
      delivery: delivery ? createDebugDeliveryStatus(delivery) : null,
      submission: submission ? createDebugSubmissionStatus(submission) : null,
      deliveryFiber: deliveryFiber
        ? createDebugFiberStatus(deliveryFiber)
        : null,
      memoryReflection: createDebugMemoryReflectionStatus(
        memoryReflection,
        memoryReflectionFiber
      )
    };
  }

  async runScheduledChannelTask(
    payload: ScheduledChannelTaskPayload,
    schedule?: ScheduledChannelTaskExecution
  ) {
    const task = getScheduledChannelTaskPayload(payload);
    if (!task) {
      logWarn("Scheduled channel task payload was invalid", {
        agentName: this.name
      });
      return;
    }

    const correlationId = createScheduledChannelTaskCorrelationId(
      task,
      schedule
    );
    try {
      await this.enqueueDiscordChat({
        responseTarget: {
          type: "channel_message",
          channelId: task.channelId
        },
        request: {
          correlationId,
          trigger: "scheduled_channel_task",
          text: createScheduledChannelTaskUserText(task),
          guildId: task.guildId,
          channelId: task.channelId,
          channel: task.channel,
          app: task.app,
          appPermissions: task.appPermissions,
          userId: task.createdByUserId,
          user: task.createdByUser
        }
      });
    } catch (error) {
      const context = {
        agentName: this.name,
        taskId: task.taskId,
        scheduleId: schedule?.id,
        scheduleType: schedule?.type,
        scheduledFor: getScheduledChannelTaskExecutionTime(schedule),
        correlationId,
        guildId: task.guildId,
        channelId: task.channelId
      };

      if (isPlatformTransientError(error)) {
        logWarn(
          "Scheduled channel task submission hit transient platform error",
          {
            ...context,
            error: getErrorMessage(error)
          }
        );
        throw error;
      }

      logError("Scheduled channel task submission failed", error, context);
    }
  }

  async housekeeping() {
    try {
      const [
        admissionReconciliation,
        componentContinuationReconciliation,
        completedDeliveryRecords,
        staleDebugResults,
        staleComponentPrompts,
        terminalSubmissions,
        memoryReflectionRecords,
        managedFiberRecords
      ] = await Promise.all([
        this.reconcileDiscordAdmissionsSafely("housekeeping"),
        this.reconcileComponentPromptContinuationsSafely("housekeeping"),
        this.discordDeliveries.pruneCompletedDeliveryRecords(),
        this.discordDeliveries.pruneStaleDebugResults(),
        this.componentPrompts.pruneStalePrompts(),
        this.deleteSubmissions({
          status: ["completed", "aborted", "skipped", "error"],
          completedBefore: new Date(
            Date.now() - TERMINAL_SUBMISSION_RETENTION_MS
          ),
          limit: 100
        }),
        this.memoryReflections.pruneTerminalRecords(
          TERMINAL_SUBMISSION_RETENTION_MS
        ),
        this.deleteFibers({
          status: ["completed", "aborted", "error"],
          settledBefore: new Date(
            Date.now() - TERMINAL_SUBMISSION_RETENTION_MS
          ),
          limit: 100
        })
      ]);
      if (
        hasDiscordAdmissionReconciliationChanges(admissionReconciliation) ||
        hasDiscordComponentContinuationReconciliationChanges(
          componentContinuationReconciliation
        ) ||
        completedDeliveryRecords > 0 ||
        staleDebugResults > 0 ||
        staleComponentPrompts > 0 ||
        terminalSubmissions > 0 ||
        memoryReflectionRecords > 0 ||
        managedFiberRecords > 0
      ) {
        logInfo("Discord housekeeping completed repairs or pruning", {
          agentName: this.name,
          ...admissionReconciliation,
          ...componentContinuationReconciliation,
          completedDeliveryRecords,
          staleDebugResults,
          staleComponentPrompts,
          terminalSubmissions,
          memoryReflectionRecords,
          managedFiberRecords
        });
      }
    } catch (error) {
      logError("Discord housekeeping failed", error, {
        agentName: this.name
      });
    }
  }

  private async submitDiscordChatDelivery(record: DiscordChatDeliveryRecord) {
    const correlationId = getDeliveryCorrelationId(record);
    const request = record.request;
    return this.submitMessages([createDiscordUserMessage(request)], {
      submissionId: correlationId,
      idempotencyKey: correlationId,
      metadata: {
        source: "discord",
        type: "chat",
        correlationId,
        discordInteractionId: record.discordInteractionId,
        sequence: record.sequence,
        guildId: request.guildId,
        channelId: request.channelId,
        userId: request.userId
      }
    });
  }

  private async startDiscordResponseDelivery(
    record: DiscordChatDeliveryRecord,
    snapshot: DiscordDeliveryFiberSnapshot
  ) {
    const fiberName = getDiscordDeliveryFiberName(record.correlationId);
    const fiber = await this.startFiber(
      fiberName,
      async (ctx) => {
        ctx.stash(snapshot);
        await this.runDiscordResponseDelivery(snapshot);
      },
      {
        idempotencyKey: fiberName,
        metadata: createDiscordDeliveryFiberMetadata(record),
        waitForCompletion: true
      }
    );

    if (fiber.status === "error") {
      const freshRecord = await this.discordDeliveries.getDelivery(
        record.correlationId
      );
      if (freshRecord && !isTerminalDelivery(freshRecord)) {
        await this.createDiscordDeliveryRunner().failDelivery(
          freshRecord,
          fiber.error ?? "Discord response delivery fiber failed."
        );
      }
    }
  }

  private async runDiscordResponseDelivery(
    snapshot: DiscordDeliveryFiberSnapshot
  ) {
    let record = await this.discordDeliveries.getDelivery(
      snapshot.correlationId
    );
    if (!record || record.type !== "chat") return;

    if (snapshot.action === "failure") {
      if (!isTerminalDelivery(record)) {
        await this.createDiscordDeliveryRunner().failDelivery(
          record,
          snapshot.error,
          snapshot.userMessage ? { userMessage: snapshot.userMessage } : {}
        );
      }
      return;
    }

    if (snapshot.action === "completed_without_response") {
      if (!isTerminalDelivery(record)) {
        await this.createDiscordDeliveryRunner().deliverCompletedSubmissionWithoutResponse(
          record
        );
      }
      return;
    }

    if (!isTerminalDelivery(record)) {
      try {
        await this.createDiscordDeliveryRunner().deliverChatResponse(
          record,
          snapshot.result
        );
      } catch (error) {
        await this.createDiscordDeliveryRunner().failDelivery(
          record,
          getErrorMessage(error)
        );
        return;
      }
    }

    record = await this.discordDeliveries.getDelivery(snapshot.correlationId);
    if (record?.type !== "chat" || record.status !== "delivered") return;

    try {
      await this.reflectGuildMemoryAfterDiscordChat(record, snapshot.result);
    } catch (error) {
      logWarn("Guild memory reflection failed after Discord delivery", {
        agentName: this.name,
        ...getDeliveryLogContext(record),
        error: getErrorMessage(error)
      });
    }
  }

  private async recoverDiscordResponseDelivery(
    ctx: FiberRecoveryContext,
    correlationId: string
  ): Promise<FiberRecoveryResult> {
    const snapshot = parseDiscordDeliveryFiberSnapshot(ctx.snapshot);
    if (!snapshot || snapshot.correlationId !== correlationId) {
      const message =
        "Discord response delivery recovery could not resume without a valid checkpoint.";
      const record = await this.discordDeliveries.getDelivery(correlationId);
      if (record && !isTerminalDelivery(record)) {
        await this.createDiscordDeliveryRunner().failDelivery(record, message);
      }
      logWarn(message, {
        agentName: this.name,
        correlationId,
        fiberId: ctx.id,
        fiberName: ctx.name,
        fiberAgeMs: Date.now() - ctx.createdAt
      });
      return { status: "error", error: message };
    }

    try {
      await this.runDiscordResponseDelivery(snapshot);
      return {
        status: "completed",
        snapshot,
        metadata: ctx.metadata ?? undefined
      };
    } catch (error) {
      const message = getErrorMessage(error);
      logWarn("Recovered Discord response delivery failed", {
        agentName: this.name,
        correlationId,
        fiberId: ctx.id,
        error: message
      });
      return { status: "error", error: message, snapshot };
    }
  }

  private async reconcileDiscordAdmissionsSafely(
    source: "on_start" | "housekeeping"
  ) {
    try {
      return await this.reconcileDiscordAdmissions();
    } catch (error) {
      logError("Discord admission reconciliation failed", error, {
        agentName: this.name,
        source
      });
      return createEmptyDiscordAdmissionReconciliationResult();
    }
  }

  private async reconcileDiscordAdmissions() {
    const result = createEmptyDiscordAdmissionReconciliationResult();
    const records = await this.discordDeliveries.listActiveDeliveryRecords(
      DISCORD_ADMISSION_RECONCILIATION_LIMIT
    );

    for (const record of records) {
      if (record.type !== "chat") continue;
      result.deliveriesInspected++;

      try {
        const submission = await this.inspectSubmission(record.correlationId);
        if (!submission) {
          await this.submitDiscordChatDelivery(record);
          result.missingSubmissionsRepaired++;
          logWarn("Repaired Discord delivery without Think submission", {
            agentName: this.name,
            sequence: record.sequence,
            ...getDeliveryLogContext(record),
            responseTargetType: record.responseTarget.type
          });
          continue;
        }

        if (submission.status === "pending") {
          await this.submitDiscordChatDelivery(record);
          result.pendingSubmissionsRearmed++;
          continue;
        }

        if (submission.status === "running") {
          await this.discordDeliveries.markRunning(record.correlationId);
          continue;
        }

        await this.onSubmissionStatus(submission);
        result.terminalDeliveriesResumed++;
      } catch (error) {
        result.reconciliationFailures++;
        logError("Discord delivery admission reconciliation failed", error, {
          agentName: this.name,
          sequence: record.sequence,
          ...getDeliveryLogContext(record),
          responseTargetType: record.responseTarget.type
        });
      }
    }

    const activeSubmissions = await this.listSubmissions({
      status: ["pending", "running"],
      limit: DISCORD_ADMISSION_RECONCILIATION_LIMIT
    });
    for (const submission of activeSubmissions) {
      if (!isDiscordChatSubmission(submission)) continue;
      const delivery = await this.discordDeliveries.getDelivery(
        submission.submissionId
      );
      if (delivery) continue;

      result.submissionsWithoutDeliveries++;
      logError(
        "Discord Think submission has no durable delivery record",
        new Error("Cannot reconstruct a Discord response target safely."),
        {
          agentName: this.name,
          correlationId: submission.submissionId,
          submissionStatus: submission.status,
          discordInteractionId: submission.metadata?.discordInteractionId,
          guildId: submission.metadata?.guildId,
          channelId: submission.metadata?.channelId,
          userId: submission.metadata?.userId
        }
      );
    }

    return result;
  }

  private async createDiscordThinkTools(
    turn: DiscordChatRequest | undefined,
    progress: DiscordProgressReporter | undefined,
    recentChannelBeforeMessageId?: string,
    discordBotUserId?: string
  ): Promise<ToolSet> {
    const toolTurn = turn
      ? this.createDiscordToolRequestContext(turn)
      : undefined;
    const tools = {
      ...createDiscordTools(this.env, {
        discordRequest: toolTurn,
        recentChannelBeforeMessageId,
        discordBotUserId,
        workspace: this.workspace,
        scheduledTasks: turn
          ? this.createScheduledTaskController(turn)
          : undefined,
        userPrompts: turn ? this.createUserPromptController(turn) : undefined,
        onArtifactCreated: async (artifact) => {
          if (!turn?.correlationId) return;
          await this.discordDeliveries.addArtifact(
            turn.correlationId,
            artifact
          );
        }
      }),
      ...createBrowserAutomationTools(this.env, this.ctx)
    };

    return withProgressTools(tools, progress);
  }

  private createDiscordToolRequestContext(
    turn: DiscordChatRequest
  ): DiscordChatRequest {
    return {
      ...turn,
      artifacts: mergeStoredArtifacts([
        ...(turn.artifacts ?? []),
        ...this.getConversationDiscordArtifacts()
      ])
    };
  }

  private startArtifactSummaries(turn: DiscordChatRequest) {
    if (this.artifactSummaryPromises.has(turn.correlationId)) return;

    const summaryPromise = (async () => {
      const record = await this.discordDeliveries.getDelivery(
        turn.correlationId
      );
      if (record?.type !== "chat") return undefined;
      const request = record.request;
      const summarizedRequest = await summarizeDiscordArtifacts(
        this.env,
        request,
        this.sessionAffinity
      );
      return summarizedRequest === request ? undefined : summarizedRequest;
    })().catch((error) => {
      logWarn("Discord artifact summaries failed", {
        agentName: this.name,
        correlationId: turn.correlationId,
        discordInteractionId: turn.discordInteractionId,
        error: getErrorMessage(error)
      });
      return undefined;
    });
    this.artifactSummaryPromises.set(turn.correlationId, summaryPromise);
  }

  private async applyArtifactSummaries(
    record: Extract<DiscordDeliveryRecord, { type: "chat" }>
  ) {
    const summaryPromise = this.artifactSummaryPromises.get(
      record.correlationId
    );
    if (!summaryPromise) return record;

    this.artifactSummaryPromises.delete(record.correlationId);
    const request = await summaryPromise;
    if (!request) return record;

    const nextRecord = { ...record, request };
    await this.updateMessageInHistory(createDiscordUserMessage(request));
    await this.discordDeliveries.updateChatRequest(
      record.correlationId,
      request
    );
    return nextRecord;
  }

  private getConversationDiscordArtifacts() {
    const artifacts: StoredResponseArtifact[] = [];
    for (const message of this.messages) {
      const turn = getDiscordTurnFromUserMessage(message);
      if (turn) {
        artifacts.push(...(turn.artifacts ?? []));
        continue;
      }

      artifacts.push(
        ...(getDiscordArtifactsFromAssistantMessage(message) ?? [])
      );
    }
    return artifacts;
  }

  private createScheduledTaskController(turn: DiscordChatRequest) {
    return createChannelScheduledTaskController(
      {
        agentName: this.name,
        scheduleChannelTask: (when, payload) =>
          this.schedule(when, SCHEDULED_CHANNEL_TASK_CALLBACK, payload),
        scheduleChannelTaskEvery: (intervalSeconds, payload) =>
          this.scheduleEvery(
            intervalSeconds,
            SCHEDULED_CHANNEL_TASK_CALLBACK,
            payload
          ),
        listSchedules: () => this.listSchedules(),
        getScheduleById: (scheduleId) => this.getScheduleById(scheduleId),
        cancelSchedule: (scheduleId) => this.cancelSchedule(scheduleId)
      },
      turn
    );
  }

  private createUserPromptController(
    turn: DiscordChatRequest
  ): UserPromptController {
    return {
      create: async (input) => {
        if (!turn.userId) {
          throw new Error(
            "Cannot create a user prompt without a Discord user ID."
          );
        }

        const prompt = await this.componentPrompts.create({
          ...input,
          allowedUserId: turn.userId,
          allowedUserDisplayName: turn.user?.displayName,
          guildId: turn.guildId,
          channelId: turn.channelId,
          sourceInteractionId: turn.discordInteractionId,
          sourceCorrelationId: turn.correlationId,
          sourceContext: createDiscordSourceTurnContext(turn)
        });
        await this.discordDeliveries.setComponentPrompt(
          turn.correlationId,
          prompt.id
        );
        return prompt;
      }
    };
  }

  async handleDiscordComponentPromptInteraction(
    input: DiscordComponentPromptInteractionInput
  ) {
    const result = await this.componentPrompts.select(input);
    if (result.status === "accepted" && result.prompt.continuation) {
      await this.submitComponentPromptContinuation(result.prompt);
    }
    return result;
  }

  private async submitComponentPromptContinuation(
    prompt: StoredComponentPrompt
  ) {
    const continuation = prompt.continuation;
    if (!continuation || continuation.status !== "pending") return false;

    try {
      await this.enqueueDiscordChat({
        responseTarget: continuation.responseTarget,
        request: continuation.request
      });
      await this.componentPrompts.markContinuationSubmitted(
        prompt.id,
        continuation.correlationId
      );
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      try {
        await this.componentPrompts.recordContinuationFailure(
          prompt.id,
          continuation.correlationId,
          message
        );
      } catch (recordError) {
        logError(
          "Discord component continuation failure could not be recorded",
          recordError,
          {
            agentName: this.name,
            promptId: prompt.id,
            correlationId: continuation.correlationId
          }
        );
      }
      logWarn("Discord component continuation admission failed", {
        agentName: this.name,
        promptId: prompt.id,
        correlationId: continuation.correlationId,
        attempts: continuation.attempts + 1,
        error: message
      });
      return false;
    }
  }

  private async reconcileComponentPromptContinuationsSafely(
    source: "on_start" | "housekeeping"
  ) {
    try {
      return await this.reconcileComponentPromptContinuations();
    } catch (error) {
      logError("Discord component continuation reconciliation failed", error, {
        agentName: this.name,
        source
      });
      return createEmptyDiscordComponentContinuationReconciliationResult();
    }
  }

  private async reconcileComponentPromptContinuations() {
    const result =
      createEmptyDiscordComponentContinuationReconciliationResult();
    const prompts = await this.componentPrompts.listPendingContinuations();
    result.continuationsInspected = prompts.length;

    for (const prompt of prompts) {
      if (await this.submitComponentPromptContinuation(prompt)) {
        result.continuationsSubmitted++;
      } else {
        result.continuationFailures++;
      }
    }

    return result;
  }

  private async createDiscordTurnRuntimeContext(turn: DiscordChatRequest) {
    const runtimeTurn = await this.withResolvedDiscordAppContext(turn);
    const sections = [formatDiscordRuntimeContext(runtimeTurn)];
    const recentChannelContext =
      await this.createRecentDiscordChannelContext(runtimeTurn);
    if (recentChannelContext.text) sections.push(recentChannelContext.text);
    return {
      text: sections.filter(Boolean).join("\n\n"),
      recentChannelBeforeMessageId: recentChannelContext.oldestVisibleMessageId,
      discordBotUserId: runtimeTurn.app?.botUserId
    };
  }

  private async withResolvedDiscordAppContext(
    turn: DiscordChatRequest
  ): Promise<DiscordChatRequest> {
    if (turn.app?.botUserId) return turn;

    const botUserId = await this.getDiscordBotUserId();
    if (!botUserId) return turn;

    return {
      ...turn,
      app: {
        ...turn.app,
        botUserId
      }
    };
  }

  private async getDiscordBotUserId() {
    if (this.botUserId) return this.botUserId;

    const stored = await this.ctx.storage.get<string>(
      DISCORD_BOT_USER_ID_STORAGE_KEY
    );
    if (stored) {
      this.botUserId = stored;
      return stored;
    }

    if (!this.botUserIdPromise) {
      this.botUserIdPromise = getCurrentBotUser(this.env)
        .then(async (user) => {
          this.botUserId = user.id;
          await this.ctx.storage.put(DISCORD_BOT_USER_ID_STORAGE_KEY, user.id);
          return user.id;
        })
        .catch((error) => {
          this.botUserIdPromise = undefined;
          logWarn("Discord bot user lookup failed", {
            agentName: this.name,
            error: getErrorMessage(error)
          });
          return undefined;
        });
    }

    return this.botUserIdPromise;
  }

  private async createRecentDiscordChannelContext(turn: DiscordChatRequest) {
    try {
      return await createRecentDiscordChannelContext(this.env, turn);
    } catch (error) {
      logWarn("Discord recent channel context fetch failed", {
        agentName: this.name,
        correlationId: turn.correlationId,
        discordInteractionId: turn.discordInteractionId,
        guildId: turn.guildId,
        channelId: turn.channelId,
        error: getErrorMessage(error)
      });
      return { text: "" };
    }
  }

  private async clearWorkspace() {
    const entries = await this.workspace.readDir("/");
    await Promise.all(
      entries.map((entry) =>
        this.workspace.rm(entry.path, { recursive: true, force: true })
      )
    );
    return entries.length;
  }

  private async clearMessagesAndStreams() {
    await this.clearMessages();
    this._resumableStream.clearAll();
  }

  private async reflectGuildMemoryAfterDiscordChat(
    record: DiscordDeliveryRecord,
    result: ChatResponseResult
  ) {
    if (record.type !== "chat") return;
    if (record.responseTarget.type === "channel_message") return;
    if (!record.request.guildId) return;

    const snapshot = createGuildMemoryReflectionSnapshot(
      record.request,
      getDiscordMessageText(result.message)
    );
    const correlationId = getDeliveryCorrelationId(record);
    const fiberName = getGuildMemoryReflectionFiberName(correlationId);

    try {
      const fiber = await this.startFiber(
        fiberName,
        async (ctx) => {
          const reflection = await this.createGuildMemoryReflectionRunner().run(
            snapshot,
            ctx
          );
          if (reflection?.changed) {
            logInfo("Guild memory reflection updated memory", {
              agentName: this.name,
              ...getDeliveryLogContext(record),
              operation: reflection.operation,
              attempts: reflection.attempts
            });
          }
        },
        {
          idempotencyKey: fiberName,
          metadata: createGuildMemoryReflectionFiberMetadata(record.request)
        }
      );

      if (!fiber.accepted) {
        logInfo("Guild memory reflection fiber already exists", {
          agentName: this.name,
          ...getDeliveryLogContext(record),
          fiberId: fiber.fiberId,
          fiberStatus: fiber.status
        });
      }
    } catch (error) {
      const message = getErrorMessage(error);
      await this.memoryReflections.fail(correlationId, message);
      throw error;
    }
  }

  private requireGuildMemoryProvider() {
    if (!this.guildMemoryProvider) {
      this.guildMemoryProvider = new GuildMemoryProvider(
        this.env.GuildMemory,
        () => getGuildIdFromDiscordConversationName(this.name)
      );
    }

    return this.guildMemoryProvider;
  }

  private createGuildMemoryReflectionRunner() {
    return new GuildMemoryReflectionRunner({
      store: this.memoryReflections,
      getProvider: () => this.requireGuildMemoryProvider(),
      createModel: (snapshot) =>
        createChatModel(
          this.env,
          CHAT_AI_GATEWAY_FLOWS.memoryReflection,
          createChatAiGatewayCorrelation(snapshot.request),
          this.sessionAffinity
        ),
      providerOptions: MEMORY_REFLECTION_PROVIDER_OPTIONS
    });
  }

  private async handleChatRecoveryExhausted(ctx: ChatRecoveryExhaustedContext) {
    logWarn("Think chat recovery exhausted", {
      agentName: this.name,
      incidentId: ctx.incidentId,
      requestId: ctx.requestId,
      recoveryRootRequestId: ctx.recoveryRootRequestId,
      attempt: ctx.attempt,
      maxAttempts: ctx.maxAttempts,
      recoveryKind: ctx.recoveryKind,
      streamId: ctx.streamId,
      reason: ctx.reason,
      partialTextLength: ctx.partialText.length,
      createdAt: new Date(ctx.createdAt).toISOString()
    });
  }

  private createDiscordDeliveryRunner() {
    return new DiscordDeliveryRunner({
      env: this.env,
      deliveries: this.discordDeliveries,
      componentPrompts: this.componentPrompts,
      updateMessageInHistory: async (message) => {
        await this.updateMessageInHistory(message);
      },
      resetSession: () =>
        clearDiscordSession({
          getPathLength: () => this.session.getPathLength(),
          clearMessages: () => this.clearMessagesAndStreams(),
          clearWorkspace: () => this.clearWorkspace()
        }),
      afterFailedDelivery: async (record) => {
        this.progressReporters.delete(getDeliveryCorrelationId(record));
        await this.housekeeping();
      },
      afterReset: () => this.housekeeping()
    });
  }

  private async getActiveProgressReporter() {
    const turn = this.getLatestDiscordTurn();
    return turn
      ? this.getOrCreateProgressReporter(turn.correlationId)
      : undefined;
  }

  private async getOrCreateProgressReporter(correlationId: string) {
    // Treat the map as a cache; durable delivery records survive hibernation.
    const existing = this.progressReporters.get(correlationId);
    if (existing) return existing;

    const record = await this.discordDeliveries.getDelivery(correlationId);
    if (!record || isTerminalDelivery(record)) return undefined;

    const concurrent = this.progressReporters.get(correlationId);
    if (concurrent) return concurrent;

    const reporter = createDiscordProgressReporter(record.responseTarget, {
      createdAt: record.createdAt,
      correlationId: getDeliveryCorrelationId(record),
      sequence: record.sequence
    });
    if (reporter) this.progressReporters.set(correlationId, reporter);
    return reporter;
  }

  private async reportDiscordRecoveryProgress(
    correlationId: string,
    event: Parameters<DiscordProgressReporter["report"]>[0]
  ) {
    const reporter = await this.getOrCreateProgressReporter(correlationId);
    await reporter?.report(event);
  }

  private async getDiscordDeliveryForChatResponse(result: ChatResponseResult) {
    const directRecord = await this.discordDeliveries.getDelivery(
      result.requestId
    );
    if (directRecord || !result.continuation) return directRecord;

    // Think gives a recovered continuation a new request ID. The Discord
    // delivery remains keyed by the stable correlation/recovery-root ID stored
    // on the originating user turn.
    const turn = this.getLatestDiscordTurn();
    if (!turn) return undefined;

    const recoveryRecord = await this.discordDeliveries.getDelivery(
      turn.correlationId
    );
    if (
      recoveryRecord?.type !== "chat" ||
      isTerminalDelivery(recoveryRecord) ||
      recoveryRecord.lifecycle?.state !== "recovering"
    ) {
      return undefined;
    }

    logInfo("Resolved recovered Discord delivery", {
      agentName: this.name,
      requestId: result.requestId,
      correlationId: turn.correlationId,
      discordInteractionId: recoveryRecord.discordInteractionId
    });
    return recoveryRecord;
  }

  private getLatestDiscordTurn(): DiscordChatRequest | undefined {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const turn = getDiscordTurnFromUserMessage(this.messages[index]);
      if (turn) return turn;
    }

    return undefined;
  }
}

function mergeStoredArtifacts(artifacts: StoredResponseArtifact[]) {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    if (seen.has(artifact.id)) return false;
    seen.add(artifact.id);
    return true;
  });
}

function createEmptyDiscordAdmissionReconciliationResult(): DiscordAdmissionReconciliationResult {
  return {
    deliveriesInspected: 0,
    missingSubmissionsRepaired: 0,
    pendingSubmissionsRearmed: 0,
    terminalDeliveriesResumed: 0,
    submissionsWithoutDeliveries: 0,
    reconciliationFailures: 0
  };
}

function hasDiscordAdmissionReconciliationChanges(
  result: DiscordAdmissionReconciliationResult
) {
  return (
    result.missingSubmissionsRepaired > 0 ||
    result.pendingSubmissionsRearmed > 0 ||
    result.terminalDeliveriesResumed > 0 ||
    result.submissionsWithoutDeliveries > 0 ||
    result.reconciliationFailures > 0
  );
}

function createEmptyDiscordComponentContinuationReconciliationResult(): DiscordComponentContinuationReconciliationResult {
  return {
    continuationsInspected: 0,
    continuationsSubmitted: 0,
    continuationFailures: 0
  };
}

function hasDiscordComponentContinuationReconciliationChanges(
  result: DiscordComponentContinuationReconciliationResult
) {
  return result.continuationsSubmitted > 0 || result.continuationFailures > 0;
}

function isDiscordChatSubmission(submission: ThinkSubmissionInspection) {
  return (
    submission.metadata?.source === "discord" &&
    submission.metadata?.type === "chat"
  );
}

function createDebugDeliveryStatus(record: DiscordDeliveryRecord) {
  const correlationId = getDeliveryCorrelationId(record);
  return {
    type: record.type,
    sequence: record.sequence,
    correlationId,
    discordInteractionId: record.discordInteractionId,
    status: record.status,
    lifecycle: record.lifecycle,
    responseTargetType: record.responseTarget.type,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    error: record.error,
    request:
      record.type === "chat"
        ? {
            guildId: record.request.guildId,
            channelId: record.request.channelId,
            userId: record.request.userId,
            textLength: record.request.text.length,
            hasChannelContext: Boolean(record.request.channel),
            hasUserContext: Boolean(record.request.user),
            hasAppPermissions: Boolean(record.request.appPermissions),
            hasUserPermissions: Boolean(record.request.userPermissions)
          }
        : {
            guildId: record.guildId,
            channelId: record.channelId,
            userId: record.userId,
            hasUserContext: Boolean(record.user)
          },
    artifacts:
      record.type === "chat"
        ? (record.artifacts ?? []).map((artifact) => ({
            artifactKey: artifact.artifactKey,
            filename: artifact.filename,
            mimeType: artifact.mimeType,
            source: artifact.source,
            description: artifact.description
          }))
        : undefined
  };
}

function getDeliveryLogContext(record: DiscordDeliveryRecord) {
  return {
    correlationId: getDeliveryCorrelationId(record),
    discordInteractionId: record.discordInteractionId
  };
}

function createChatAiGatewayCorrelation(
  turn: DiscordChatRequest | undefined
): ChatAiGatewayCorrelation {
  return {
    correlationId: turn?.correlationId,
    guildId: turn?.guildId,
    channelId: turn?.channelId
  };
}

function createScheduledChannelTaskCorrelationId(
  task: ScheduledChannelTaskPayload,
  schedule: ScheduledChannelTaskExecution | undefined
) {
  const executionId = schedule
    ? `${sanitizeCorrelationIdFragment(schedule.id)}-${sanitizeCorrelationIdFragment(
        Math.trunc(schedule.time)
      )}`
    : crypto.randomUUID();

  return `scheduled-${sanitizeCorrelationIdFragment(task.taskId)}-${executionId}`;
}

function getScheduledChannelTaskExecutionTime(
  schedule: ScheduledChannelTaskExecution | undefined
) {
  if (!schedule || !Number.isFinite(schedule.time)) return undefined;
  const date = new Date(schedule.time * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function sanitizeCorrelationIdFragment(value: string | number) {
  return String(value).replace(/[^A-Za-z0-9_.:-]/g, "_");
}

function createDebugSubmissionStatus(submission: ThinkSubmissionInspection) {
  return {
    submissionId: submission.submissionId,
    idempotencyKey: submission.idempotencyKey,
    requestId: submission.requestId,
    status: submission.status,
    error: submission.error,
    metadata: sanitizeSubmissionMetadata(submission.metadata),
    createdAt: toIsoTimestamp(submission.createdAt),
    startedAt: toOptionalIsoTimestamp(submission.startedAt),
    completedAt: toOptionalIsoTimestamp(submission.completedAt)
  };
}

function createDebugMemoryReflectionStatus(
  reflection: GuildMemoryReflectionRecord | undefined,
  fiber: FiberInspection | null
) {
  if (!reflection && !fiber) return null;
  const fiberCorrelationId = getGuildMemoryReflectionCorrelationId(
    fiber?.name ?? ""
  );
  const correlationId = reflection?.correlationId ?? fiberCorrelationId;

  return {
    correlationId,
    discordInteractionId: reflection?.discordInteractionId,
    status: reflection?.status,
    changed: reflection?.changed,
    operation: reflection?.operation,
    attempts: reflection?.attempts,
    error: reflection?.error,
    createdAt: reflection?.createdAt,
    updatedAt: reflection?.updatedAt,
    fiber: fiber ? createDebugFiberStatus(fiber) : null
  };
}

function createDebugFiberStatus(fiber: FiberInspection) {
  return {
    fiberId: fiber.fiberId,
    name: fiber.name,
    idempotencyKey: fiber.idempotencyKey,
    status: fiber.status,
    error: fiber.error,
    metadata: sanitizeSubmissionMetadata(fiber.metadata),
    createdAt: toIsoTimestamp(fiber.createdAt),
    startedAt: toOptionalIsoTimestamp(fiber.startedAt),
    settledAt: toOptionalIsoTimestamp(fiber.settledAt)
  };
}

function createGuildMemoryReflectionFiberMetadata(
  request: DiscordChatRequest
): Record<string, string | number | boolean | null | undefined> {
  return {
    source: "discord",
    type: "guild_memory_reflection",
    correlationId: request.correlationId,
    discordInteractionId: request.discordInteractionId,
    guildId: request.guildId,
    channelId: request.channelId,
    userId: request.userId
  };
}

function sanitizeSubmissionMetadata(metadata?: Record<string, unknown>) {
  if (!metadata) return undefined;

  const safeKeys = [
    "source",
    "type",
    "correlationId",
    "discordInteractionId",
    "sequence",
    "guildId",
    "channelId",
    "userId"
  ];
  const result: Record<string, string | number | boolean | null> = {};

  for (const key of safeKeys) {
    const value = metadata[key];
    if (isSafeMetadataValue(value)) result[key] = value;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function isSafeMetadataValue(
  value: unknown
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function toOptionalIsoTimestamp(value?: number) {
  return typeof value === "number" ? toIsoTimestamp(value) : undefined;
}

function toIsoTimestamp(value: number) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
