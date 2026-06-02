import {
  Think,
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
import { Workspace } from "@cloudflare/shell";
import { Session } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { generateText, type ToolSet } from "ai";
import { createChannelScheduledTaskController } from "./channel-scheduler";
import { createRecentDiscordChannelContext } from "./discord/channel-context";
import { formatDiscordRuntimeContext } from "./discord/context";
import { getGuildIdFromDiscordConversationName } from "./discord/conversation";
import {
  DiscordDeliveryStore,
  isTerminalDelivery,
  type DiscordDeliveryChatInput,
  type DiscordDeliveryRecord,
  type DiscordDeliveryResetInput
} from "./discord/delivery";
import { DiscordDeliveryRunner } from "./discord/delivery-runner";
import { inlineDataUrls } from "./discord/format";
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
  parseGuildMemoryReflectionSnapshot
} from "./memory-reflection";
import {
  CHAT_MODEL,
  COMPACTION_PROVIDER_OPTIONS,
  COMPACTION_TAIL_TOKEN_BUDGET,
  COMPACTION_TOKEN_THRESHOLD,
  CHAT_AI_GATEWAY_FLOWS,
  createChatWorkersAI,
  MEMORY_REFLECTION_PROVIDER_OPTIONS,
  REPLY_PROVIDER_OPTIONS
} from "./model";
import { createBaseSystemPrompt } from "./prompts";
import {
  createScheduledChannelTaskUserText,
  getScheduledChannelTaskPayload,
  SCHEDULED_CHANNEL_TASK_CALLBACK,
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
import { createDiscordCodeModeTool, createDiscordTools } from "./tools";

const HOUSEKEEPING_INTERVAL_SECONDS = 24 * 60 * 60;
const TERMINAL_SUBMISSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DISCORD_ACTIVE_TOOLS = ["codemode"];

export class ChatAgent extends Think<Env> {
  override sendReasoning = false;
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "codemode",
    name: () => this.name
  });

  private discordDeliveries = new DiscordDeliveryStore(this.ctx.storage);
  private memoryReflections = new GuildMemoryReflectionStore(this.ctx.storage);
  private progressReporters = new Map<string, DiscordProgressReporter>();
  private guildMemoryProvider?: GuildMemoryProvider;

  override getModel() {
    const workersai = createChatWorkersAI(
      this.env,
      CHAT_AI_GATEWAY_FLOWS.reply
    );
    return workersai(CHAT_MODEL, {
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
            const workersai = createChatWorkersAI(
              this.env,
              CHAT_AI_GATEWAY_FLOWS.compaction
            );
            const result = await generateText({
              model: workersai(CHAT_MODEL, {
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
      await this.createDiscordDeliveryRunner().failDelivery(
        record,
        submission.error ??
          `Think submission ended with status ${submission.status}.`
      );
    }
  }

  override onChatError(error: unknown) {
    logError("Think chat turn failed", error, {
      agentName: this.name
    });
    return super.onChatError(error);
  }

  override async onFiberRecovered(ctx: FiberRecoveryContext) {
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
      return;
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
    } catch (error) {
      logWarn("Recovered guild memory reflection failed", {
        agentName: this.name,
        interactionId,
        fiberId: ctx.id,
        error: getErrorMessage(error)
      });
    }
  }

  async enqueueDiscordChat(input: DiscordDeliveryChatInput) {
    const result = await this.discordDeliveries.create(input);
    if (!result.created || !result.record) return;

    const record = result.record;
    const progress = createDiscordProgressReporter(record.responseTarget, {
      createdAt: record.createdAt,
      interactionId: record.interactionId,
      sequence: record.sequence
    });
    if (progress) this.progressReporters.set(record.interactionId, progress);

    try {
      await this.submitMessages([createDiscordUserMessage(input.request)], {
        submissionId: input.request.interactionId,
        idempotencyKey: input.request.interactionId,
        metadata: {
          source: "discord",
          type: "chat",
          sequence: record.sequence,
          guildId: input.request.guildId,
          channelId: input.request.channelId,
          userId: input.request.userId
        }
      });
    } catch (error) {
      this.progressReporters.delete(record.interactionId);
      await this.discordDeliveries.deleteCreatedDelivery(record);
      logError("Discord Think submission failed", error, {
        sequence: record.sequence,
        interactionId: record.interactionId,
        deliveryType: record.type
      });
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

  async runScheduledChannelTask(payload: ScheduledChannelTaskPayload) {
    const task = getScheduledChannelTaskPayload(payload);
    if (!task) {
      logWarn("Scheduled channel task payload was invalid", {
        agentName: this.name
      });
      return;
    }

    const interactionId = `scheduled-${task.taskId}-${crypto.randomUUID()}`;
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
          appPermissions: task.appPermissions,
          userId: task.createdByUserId,
          user: task.createdByUser
        }
      });
    } catch (error) {
      logError("Scheduled channel task submission failed", error, {
        agentName: this.name,
        taskId: task.taskId,
        guildId: task.guildId,
        channelId: task.channelId
      });
    }
  }

  async housekeeping() {
    try {
      const [
        completedDeliveryRecords,
        staleDebugResults,
        terminalSubmissions,
        memoryReflectionRecords
      ] = await Promise.all([
        this.discordDeliveries.pruneCompletedDeliveryRecords(),
        this.discordDeliveries.pruneStaleDebugResults(),
        this.deleteSubmissions({
          status: ["completed", "aborted", "skipped", "error"],
          completedBefore: new Date(
            Date.now() - TERMINAL_SUBMISSION_RETENTION_MS
          ),
          limit: 100
        }),
        this.memoryReflections.pruneTerminalRecords(
          TERMINAL_SUBMISSION_RETENTION_MS
        )
      ]);

      if (
        completedDeliveryRecords > 0 ||
        staleDebugResults > 0 ||
        terminalSubmissions > 0 ||
        memoryReflectionRecords > 0
      ) {
        logInfo("Discord housekeeping pruned stale records", {
          agentName: this.name,
          completedDeliveryRecords,
          staleDebugResults,
          terminalSubmissions,
          memoryReflectionRecords
        });
      }
    } catch (error) {
      logError("Discord housekeeping failed", error, {
        agentName: this.name
      });
    }
  }

  private async createDiscordThinkTools(
    turn: DiscordChatRequest | undefined,
    progress: DiscordProgressReporter | undefined
  ): Promise<ToolSet> {
    const directTools = withProgressTools(
      {
        ...createDiscordTools(this.env, {
          discordRequest: turn,
          workspace: this.workspace,
          scheduledTasks: turn
            ? this.createScheduledTaskController(turn)
            : undefined,
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

    return {
      codemode: createDiscordCodeModeTool(this.env, directTools, this.workspace)
    };
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

  private async createDiscordTurnRuntimeContext(turn: DiscordChatRequest) {
    const sections = [formatDiscordRuntimeContext(turn)];
    const recentChannelContext =
      await this.createRecentDiscordChannelContext(turn);
    if (recentChannelContext) sections.push(recentChannelContext);
    return sections.filter(Boolean).join("\n\n");
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

    try {
      const reflection = await this.runFiber(
        getGuildMemoryReflectionFiberName(record.interactionId),
        async (ctx) =>
          this.createGuildMemoryReflectionRunner().run(
            createGuildMemoryReflectionSnapshot(
              record.request,
              getDiscordMessageText(result.message)
            ),
            ctx
          )
      );

      if (reflection?.changed) {
        logInfo("Guild memory reflection updated memory", {
          agentName: this.name,
          interactionId: record.interactionId,
          operation: reflection.operation,
          attempts: reflection.attempts
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
    const workersai = createChatWorkersAI(
      this.env,
      CHAT_AI_GATEWAY_FLOWS.memoryReflection
    );
    return new GuildMemoryReflectionRunner({
      store: this.memoryReflections,
      getProvider: () => this.requireGuildMemoryProvider(),
      createModel: () =>
        workersai(CHAT_MODEL, {
          sessionAffinity: this.sessionAffinity
        }),
      providerOptions: MEMORY_REFLECTION_PROVIDER_OPTIONS
    });
  }

  private createDiscordDeliveryRunner() {
    return new DiscordDeliveryRunner({
      env: this.env,
      deliveries: this.discordDeliveries,
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

  private getLatestDiscordTurn(): DiscordChatRequest | undefined {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const turn = getDiscordTurnFromUserMessage(this.messages[index]);
      if (turn) return turn;
    }

    return undefined;
  }
}
