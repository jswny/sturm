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
  type ToolCallContext,
  type ToolCallResultContext,
  type TurnConfig,
  type TurnContext
} from "@cloudflare/think";
import type { ExecutionState } from "@cloudflare/codemode";
import { Workspace } from "@cloudflare/shell";
import {
  isPlatformTransientError,
  type FiberInspection,
  type FiberRecoveryResult
} from "agents";
import { Session } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { generateText, type ToolSet } from "ai";
import { createChannelScheduledTaskController } from "./channel-scheduler";
import {
  createCodeModeInspection,
  normalizeCodeModeInspectionRequest,
  type CodeModeInspectionRequest
} from "./codemode-inspection";
import { createRecentDiscordChannelContext } from "./discord/channel-context";
import {
  DiscordComponentPromptStore,
  formatComponentPromptContinuationText,
  type DiscordComponentPromptInteractionInput
} from "./discord/component-prompts";
import { formatDiscordRuntimeContext } from "./discord/context";
import { getGuildIdFromDiscordConversationName } from "./discord/conversation";
import {
  DiscordDeliveryStore,
  isTerminalDelivery,
  type DiscordCodeModeExecutionReferenceInput,
  type DiscordDeliveryChatInput,
  type DiscordDeliveryRecord,
  type DiscordDeliveryResetInput
} from "./discord/delivery";
import { DiscordDeliveryRunner } from "./discord/delivery-runner";
import { inlineDataUrls } from "./discord/format";
import { getCurrentBotUser } from "./discord/api";
import {
  createDiscordProgressReporter,
  withProgressTools
} from "./discord/progress";
import type { DiscordProgressReporter } from "./discord/progress";
import {
  clearDiscordSession,
  createDiscordUserMessage,
  getDiscordTurnFromUserMessage,
  getDiscordMessageText
} from "./discord/turn";
import type { DiscordChatRequest, DiscordChatResponse } from "./discord/types";
import { GuildMemoryReflectionRunner } from "./guild-memory-reflection-runner";
import { getErrorMessage, logError, logInfo, logWarn } from "./logging";
import { GuildMemoryProvider } from "./memory";
import {
  createGuildMemoryReflectionSnapshot,
  getGuildMemoryReflectionFiberName,
  getGuildMemoryReflectionInteractionId,
  GuildMemoryReflectionStore,
  parseGuildMemoryReflectionSnapshot,
  type GuildMemoryReflectionRecord
} from "./memory-reflection";
import {
  COMPACTION_CHAT_MODEL,
  COMPACTION_PROVIDER_OPTIONS,
  COMPACTION_TAIL_TOKEN_BUDGET,
  COMPACTION_TOKEN_THRESHOLD,
  CONTEXT_OVERFLOW_HEADROOM,
  CONTEXT_OVERFLOW_MAX_INPUT_TOKENS,
  CHAT_AI_GATEWAY_FLOWS,
  type ChatAiGatewayCorrelation,
  createChatWorkersAI,
  MEMORY_REFLECTION_CHAT_MODEL,
  MEMORY_REFLECTION_PROVIDER_OPTIONS,
  REPLY_CHAT_MODEL,
  REPLY_PROVIDER_OPTIONS
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
import { createDiscordCodeModeRuntime, createDiscordTools } from "./tools";
import type { DiscordCodeModeRuntime } from "./tools/codemode";
import type { UserPromptController } from "./tools/user-prompts";

const HOUSEKEEPING_INTERVAL_SECONDS = 24 * 60 * 60;
const TERMINAL_SUBMISSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CODEMODE_STALE_EXECUTION_TTL_MS = 24 * 60 * 60 * 1000;
const CODEMODE_INSPECTION_MAX_EXECUTIONS = 50;
const DISCORD_ACTIVE_TOOLS = ["codemode"];
const CHAT_RECOVERY_MAX_ATTEMPTS = 6;
const CHAT_RECOVERY_STABLE_TIMEOUT_MS = 10_000;
const CHAT_STREAM_STALL_TIMEOUT_MS = 120_000;
const CHAT_RECOVERY_TERMINAL_MESSAGE =
  "Sorry, this request was interrupted and could not be recovered. Please try again.";
const DISCORD_BOT_USER_ID_STORAGE_KEY = "discord:bot-user-id";

type ScheduledChannelTaskExecution = Pick<
  ScheduledChannelTaskSchedule,
  "id" | "time" | "type"
>;

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
    namespace: "codemode",
    name: () => this.name
  });

  private discordDeliveries = new DiscordDeliveryStore(this.ctx.storage);
  private componentPrompts = new DiscordComponentPromptStore(this.ctx.storage);
  private memoryReflections = new GuildMemoryReflectionStore(this.ctx.storage);
  private progressReporters = new Map<string, DiscordProgressReporter>();
  private guildMemoryProvider?: GuildMemoryProvider;
  private codeModeRuntime?: DiscordCodeModeRuntime["runtime"];
  private botUserId?: string;
  private botUserIdPromise?: Promise<string | undefined>;

  override getModel() {
    const turn = this.getLatestDiscordTurn();
    const workersai = createChatWorkersAI(
      this.env,
      CHAT_AI_GATEWAY_FLOWS.reply,
      createChatAiGatewayCorrelation(turn)
    );
    return workersai(REPLY_CHAT_MODEL, {
      sessionAffinity: this.sessionAffinity
    });
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
            const workersai = createChatWorkersAI(
              this.env,
              CHAT_AI_GATEWAY_FLOWS.compaction,
              createChatAiGatewayCorrelation(turn)
            );
            const result = await generateText({
              model: workersai(COMPACTION_CHAT_MODEL, {
                sessionAffinity: this.sessionAffinity
              }),
              providerOptions: COMPACTION_PROVIDER_OPTIONS,
              system:
                "Summarize Discord conversation history for future assistant context. Preserve factual details, user preferences, decisions, current state, and open items.",
              prompt
            });
            return result.text;
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
  }

  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig> {
    const turn = this.getLatestDiscordTurn();
    const progress = turn
      ? this.progressReporters.get(turn.interactionId)
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

    return {
      system: createDiscordThinkSystemPrompt(sessionContext, runtimeContext),
      messages: inlineDataUrls(ctx.messages),
      tools: await this.createDiscordThinkTools(turn, progress),
      activeTools: DISCORD_ACTIVE_TOOLS,
      maxSteps: this.maxSteps,
      sendReasoning: false,
      providerOptions: REPLY_PROVIDER_OPTIONS as Record<string, unknown>
    };
  }

  override async beforeStep(ctx: PrepareStepContext) {
    const progress = this.getActiveProgressReporter();
    await progress?.report({
      type: "phase",
      label:
        ctx.stepNumber === 0
          ? "Thinking through the request"
          : "Reviewing tool results"
    });
  }

  override async beforeToolCall(ctx: ToolCallContext) {
    if (ctx.toolName !== "codemode") return;
    await this.getActiveProgressReporter()?.report({
      type: "tool",
      label: "code mode",
      status: "started"
    });
  }

  override async afterToolCall(ctx: ToolCallResultContext) {
    if (ctx.toolName !== "codemode") return;
    if (ctx.success) {
      await this.recordCodeModeExecution(ctx);
    }
    if (!ctx.success) {
      logWarn("Code mode tool call failed", {
        agentName: this.name,
        toolName: ctx.toolName,
        stepNumber: ctx.stepNumber,
        durationMs: ctx.durationMs,
        error: getErrorMessage(ctx.error)
      });
    }
    await this.getActiveProgressReporter()?.report({
      type: "tool",
      label: "code mode",
      status: ctx.success ? "finished" : "failed"
    });
  }

  override async onStepFinish(ctx: StepContext) {
    const usage = ctx.usage;
    logInfo("Think turn step finished", {
      agentName: this.name,
      finishReason: ctx.finishReason,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      reasoningTokens: usage?.reasoningTokens,
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
    const record = await this.discordDeliveries.getDelivery(result.requestId);
    if (!record || isTerminalDelivery(record)) return;

    if (result.status !== "completed") {
      await this.createDiscordDeliveryRunner().failDelivery(
        record,
        result.error ?? `Think turn ended with status ${result.status}.`
      );
      return;
    }

    try {
      try {
        await this.createDiscordDeliveryRunner().deliverChatResponse(
          record,
          result
        );
      } catch (error) {
        await this.createDiscordDeliveryRunner().failDelivery(
          record,
          getErrorMessage(error)
        );
        return;
      }

      try {
        await this.reflectGuildMemoryAfterDiscordChat(record, result);
      } catch (error) {
        logWarn("Guild memory reflection failed after Discord delivery", {
          agentName: this.name,
          interactionId: record.interactionId,
          error: getErrorMessage(error)
        });
      }
    } finally {
      this.progressReporters.delete(record.interactionId);
      await this.housekeeping();
    }
  }

  override async onSubmissionStatus(submission: ThinkSubmissionInspection) {
    const record = await this.discordDeliveries.getDelivery(
      submission.submissionId
    );
    if (!record || isTerminalDelivery(record)) return;

    if (submission.status === "running") {
      await this.discordDeliveries.markRunning(record.interactionId);
      return;
    }

    if (submission.status === "completed") {
      await this.createDiscordDeliveryRunner().deliverCompletedSubmissionWithoutResponse(
        record
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
      await this.createDiscordDeliveryRunner().failDelivery(
        record,
        error,
        error === CHAT_RECOVERY_TERMINAL_MESSAGE ? { userMessage: error } : {}
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
    const interactionId = getGuildMemoryReflectionInteractionId(ctx.name);
    if (!interactionId) return super.onFiberRecovered(ctx);

    const snapshot = parseGuildMemoryReflectionSnapshot(ctx.snapshot);
    if (!snapshot) {
      const message =
        "Guild memory reflection recovery could not resume without a valid checkpoint.";
      await this.memoryReflections.fail(interactionId, message);
      logWarn(message, {
        agentName: this.name,
        interactionId,
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
          interactionId,
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
        interactionId,
        fiberId: ctx.id,
        error: message
      });
      return { status: "error", error: message };
    }
  }

  async enqueueDiscordChat(input: DiscordDeliveryChatInput) {
    const result = await this.discordDeliveries.create(input);
    if (!result.record || result.record.type !== "chat") return;

    const record = result.record;
    if (isTerminalDelivery(record)) return;

    if (!result.created) {
      const existingSubmission = await this.inspectSubmission(
        record.interactionId
      );
      if (existingSubmission) return;

      logWarn("Repairing pending Discord delivery without Think submission", {
        sequence: record.sequence,
        interactionId: record.interactionId,
        deliveryType: record.type,
        responseTargetType: record.responseTarget.type
      });
    }

    const progress = createDiscordProgressReporter(record.responseTarget, {
      createdAt: record.createdAt,
      interactionId: record.interactionId,
      sequence: record.sequence
    });
    if (progress && !this.progressReporters.has(record.interactionId)) {
      this.progressReporters.set(record.interactionId, progress);
    }

    try {
      await this.submitMessages([createDiscordUserMessage(record.request)], {
        submissionId: record.interactionId,
        idempotencyKey: record.interactionId,
        metadata: {
          source: "discord",
          type: "chat",
          sequence: record.sequence,
          guildId: record.request.guildId,
          channelId: record.request.channelId,
          userId: record.request.userId
        }
      });
    } catch (error) {
      this.progressReporters.delete(record.interactionId);
      if (result.created) {
        await this.discordDeliveries.deleteCreatedDelivery(record);
      }
      const context = {
        sequence: record.sequence,
        interactionId: record.interactionId,
        deliveryType: record.type
      };
      if (isPlatformTransientError(error)) {
        logWarn("Discord Think submission hit transient platform error", {
          ...context,
          error: getErrorMessage(error)
        });
      } else {
        logError("Discord Think submission failed", error, context);
      }
      throw error;
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
      responseTarget: { type: "debug", id: request.interactionId },
      request
    });
    return this.createDiscordDeliveryRunner().waitForDebugQueuedResponse(
      request.interactionId
    );
  }

  async runDebugQueuedDiscordReset(
    input: Omit<DiscordDeliveryResetInput, "responseTarget">
  ): Promise<DiscordChatResponse> {
    await this.enqueueDiscordReset({
      ...input,
      responseTarget: { type: "debug", id: input.interactionId }
    });
    return this.createDiscordDeliveryRunner().waitForDebugQueuedResponse(
      input.interactionId
    );
  }

  async getDebugDiscordStatus(interactionId: string) {
    const [delivery, submission, memoryReflection, memoryReflectionFiber] =
      await Promise.all([
        this.discordDeliveries.getDelivery(interactionId),
        this.inspectSubmission(interactionId),
        this.memoryReflections.get(interactionId),
        this.inspectFiberByKey(getGuildMemoryReflectionFiberName(interactionId))
      ]);

    return {
      delivery: delivery ? createDebugDeliveryStatus(delivery) : null,
      submission: submission ? createDebugSubmissionStatus(submission) : null,
      memoryReflection: createDebugMemoryReflectionStatus(
        memoryReflection,
        memoryReflectionFiber
      )
    };
  }

  async inspectCodeModeRuntime(request: CodeModeInspectionRequest = {}) {
    const normalized = normalizeCodeModeInspectionRequest(request);
    const runtime =
      this.codeModeRuntime ??
      (await this.createDiscordCodeModeRuntime(undefined, undefined)).runtime;
    const delivery = normalized.interactionId
      ? await this.discordDeliveries.getDelivery(normalized.interactionId)
      : undefined;
    const codeModeExecutions =
      delivery?.type === "chat" ? (delivery.codeModeExecutions ?? []) : [];
    const correlatedExecutionIds = codeModeExecutions.map(
      (execution) => execution.executionId
    );
    const requestedExecutionIds = normalized.executionId
      ? [normalized.executionId]
      : normalized.interactionId
        ? correlatedExecutionIds
        : undefined;
    const executionLimit =
      requestedExecutionIds !== undefined
        ? CODEMODE_INSPECTION_MAX_EXECUTIONS
        : normalized.limit;
    const executions = await runtime.executions(executionLimit);
    const pendingActions =
      requestedExecutionIds !== undefined
        ? requestedExecutionIds.length > 0
          ? (
              await Promise.all(
                requestedExecutionIds.map((executionId) =>
                  runtime.pending(executionId)
                )
              )
            ).flat()
          : []
        : await runtime.pending(normalized.executionId);

    return createCodeModeInspection({
      executions: executions as ExecutionState[],
      pendingActions,
      request: normalized,
      inspectedAt: new Date().toISOString(),
      requestedExecutionIds,
      correlation: normalized.interactionId
        ? {
            interactionId: normalized.interactionId,
            deliveryFound: Boolean(delivery),
            deliveryType: delivery?.type,
            codeModeExecutions
          }
        : undefined
    });
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

    const interactionId = createScheduledChannelTaskInteractionId(
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
          interactionId,
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
        interactionId,
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
        completedDeliveryRecords,
        staleDebugResults,
        staleComponentPrompts,
        terminalSubmissions,
        memoryReflectionRecords,
        managedFiberRecords,
        staleCodeModeExecutions
      ] = await Promise.all([
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
        }),
        this.expireStaleCodeModeExecutions()
      ]);

      if (
        completedDeliveryRecords > 0 ||
        staleDebugResults > 0 ||
        staleComponentPrompts > 0 ||
        terminalSubmissions > 0 ||
        memoryReflectionRecords > 0 ||
        managedFiberRecords > 0 ||
        staleCodeModeExecutions > 0
      ) {
        logInfo("Discord housekeeping pruned stale records", {
          agentName: this.name,
          completedDeliveryRecords,
          staleDebugResults,
          staleComponentPrompts,
          terminalSubmissions,
          memoryReflectionRecords,
          managedFiberRecords,
          staleCodeModeExecutions
        });
      }
    } catch (error) {
      logError("Discord housekeeping failed", error, {
        agentName: this.name
      });
    }
  }

  private async expireStaleCodeModeExecutions() {
    const runtime =
      this.codeModeRuntime ??
      (await this.createDiscordCodeModeRuntime(undefined, undefined)).runtime;
    const expired = await runtime.expirePaused({
      maxAgeMs: CODEMODE_STALE_EXECUTION_TTL_MS
    });
    return expired.length;
  }

  private async createDiscordThinkTools(
    turn: DiscordChatRequest | undefined,
    progress: DiscordProgressReporter | undefined
  ): Promise<ToolSet> {
    const codeMode = await this.createDiscordCodeModeRuntime(turn, progress);
    return {
      codemode: codeMode.tool
    };
  }

  private async createDiscordCodeModeRuntime(
    turn: DiscordChatRequest | undefined,
    progress: DiscordProgressReporter | undefined
  ): Promise<DiscordCodeModeRuntime> {
    const directTools = withProgressTools(
      {
        ...createDiscordTools(this.env, {
          discordRequest: turn,
          workspace: this.workspace,
          scheduledTasks: turn
            ? this.createScheduledTaskController(turn)
            : undefined,
          userPrompts: turn ? this.createUserPromptController(turn) : undefined,
          onArtifactCreated: async (artifact) => {
            if (!turn?.interactionId) return;
            await this.discordDeliveries.addArtifact(
              turn.interactionId,
              artifact
            );
          }
        })
      },
      progress
    );

    const codeMode = createDiscordCodeModeRuntime(
      this.env,
      directTools,
      this.workspace,
      this.ctx
    );
    this.codeModeRuntime = codeMode.runtime;
    return codeMode;
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
          sourceInteractionId: turn.interactionId
        });
        await this.discordDeliveries.setComponentPrompt(
          turn.interactionId,
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
    if (result.status !== "accepted" || !result.option.pendingAction) {
      return result;
    }

    const prompt = result.prompt;
    const channelId = prompt.channelId ?? input.channelId;
    if (!channelId) return result;

    const text = formatComponentPromptContinuationText(prompt, result.option);
    await this.enqueueDiscordChat({
      responseTarget: {
        type: "channel_message",
        channelId
      },
      request: {
        interactionId: input.interactionId,
        text,
        emptyResponseBehavior: "suppress",
        guildId: prompt.guildId ?? input.guildId,
        channelId: prompt.channelId ?? input.channelId,
        channel: input.channel,
        app: input.app,
        appPermissions: input.appPermissions,
        userId: input.userId,
        user: input.user,
        userPermissions: input.userPermissions
      }
    });

    return result;
  }

  private async createDiscordTurnRuntimeContext(turn: DiscordChatRequest) {
    const runtimeTurn = await this.withResolvedDiscordAppContext(turn);
    const sections = [formatDiscordRuntimeContext(runtimeTurn)];
    const recentChannelContext =
      await this.createRecentDiscordChannelContext(runtimeTurn);
    if (recentChannelContext) sections.push(recentChannelContext);
    return sections.filter(Boolean).join("\n\n");
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
        interactionId: turn.interactionId,
        guildId: turn.guildId,
        channelId: turn.channelId,
        error: getErrorMessage(error)
      });
      return "";
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
    const fiberName = getGuildMemoryReflectionFiberName(record.interactionId);

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
              interactionId: record.interactionId,
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
          interactionId: record.interactionId,
          fiberId: fiber.fiberId,
          fiberStatus: fiber.status
        });
      }
    } catch (error) {
      const message = getErrorMessage(error);
      await this.memoryReflections.fail(record.interactionId, message);
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
      createModel: (snapshot) => {
        const correlatedWorkersAI = createChatWorkersAI(
          this.env,
          CHAT_AI_GATEWAY_FLOWS.memoryReflection,
          createChatAiGatewayCorrelation(snapshot.request)
        );
        return correlatedWorkersAI(MEMORY_REFLECTION_CHAT_MODEL, {
          sessionAffinity: this.sessionAffinity
        });
      },
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
        this.progressReporters.delete(record.interactionId);
        await this.housekeeping();
      },
      afterReset: () => this.housekeeping()
    });
  }

  private getActiveProgressReporter() {
    const turn = this.getLatestDiscordTurn();
    return turn ? this.progressReporters.get(turn.interactionId) : undefined;
  }

  private async recordCodeModeExecution(ctx: ToolCallResultContext) {
    const reference = createCodeModeExecutionReference(ctx);
    if (!reference) return;

    const turn = this.getLatestDiscordTurn();
    if (!turn) return;

    try {
      await this.discordDeliveries.addCodeModeExecution(
        turn.interactionId,
        reference
      );
    } catch (error) {
      logWarn("Code mode execution correlation failed", {
        agentName: this.name,
        interactionId: turn.interactionId,
        executionId: reference.executionId,
        error: getErrorMessage(error)
      });
    }
  }

  private async reportDiscordRecoveryProgress(
    interactionId: string,
    event: Parameters<DiscordProgressReporter["report"]>[0]
  ) {
    const reporter = this.progressReporters.get(interactionId);
    if (reporter) {
      await reporter.report(event);
      return;
    }

    const record = await this.discordDeliveries.getDelivery(interactionId);
    if (!record) return;

    const recoveryReporter = createDiscordProgressReporter(
      record.responseTarget,
      {
        createdAt: record.createdAt,
        interactionId: record.interactionId,
        sequence: record.sequence
      }
    );
    await recoveryReporter?.report(event);
  }

  private getLatestDiscordTurn(): DiscordChatRequest | undefined {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const turn = getDiscordTurnFromUserMessage(this.messages[index]);
      if (turn) return turn;
    }

    return undefined;
  }
}

function createDebugDeliveryStatus(record: DiscordDeliveryRecord) {
  return {
    type: record.type,
    sequence: record.sequence,
    interactionId: record.interactionId,
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
        : undefined,
    codeModeExecutions:
      record.type === "chat" ? record.codeModeExecutions : undefined
  };
}

function createChatAiGatewayCorrelation(
  turn: DiscordChatRequest | undefined
): ChatAiGatewayCorrelation {
  return {
    interactionId: turn?.interactionId,
    guildId: turn?.guildId,
    channelId: turn?.channelId
  };
}

function createCodeModeExecutionReference(
  ctx: ToolCallResultContext
): DiscordCodeModeExecutionReferenceInput | undefined {
  if (!ctx.success) return undefined;
  const output = ctx.output;
  if (!isObjectRecord(output)) return undefined;

  const executionId = output.executionId;
  if (typeof executionId !== "string" || !executionId.trim()) return undefined;

  return {
    executionId,
    status: getCodeModeExecutionStatus(output.status),
    toolCallId: typeof ctx.toolCallId === "string" ? ctx.toolCallId : undefined,
    stepNumber: ctx.stepNumber,
    durationMs: ctx.durationMs
  };
}

function getCodeModeExecutionStatus(
  status: unknown
): DiscordCodeModeExecutionReferenceInput["status"] {
  return status === "completed" || status === "paused" || status === "error"
    ? status
    : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function createScheduledChannelTaskInteractionId(
  task: ScheduledChannelTaskPayload,
  schedule: ScheduledChannelTaskExecution | undefined
) {
  const executionId = schedule
    ? `${sanitizeInteractionIdFragment(schedule.id)}-${sanitizeInteractionIdFragment(
        Math.trunc(schedule.time)
      )}`
    : crypto.randomUUID();

  return `scheduled-${sanitizeInteractionIdFragment(task.taskId)}-${executionId}`;
}

function getScheduledChannelTaskExecutionTime(
  schedule: ScheduledChannelTaskExecution | undefined
) {
  if (!schedule || !Number.isFinite(schedule.time)) return undefined;
  const date = new Date(schedule.time * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function sanitizeInteractionIdFragment(value: string | number) {
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

  return {
    interactionId:
      reflection?.interactionId ??
      getGuildMemoryReflectionInteractionId(fiber?.name ?? ""),
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
    interactionId: request.interactionId,
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
    "interactionId",
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
