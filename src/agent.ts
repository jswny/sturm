import {
  Think,
  type ChatResponseResult,
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
import { PermissionFlagsBits } from "discord-api-types/v10";
import { createWorkersAI } from "workers-ai-provider";
import {
  deliverChannelMessage,
  deliverInteractionResponse,
  editOriginalInteractionResponse
} from "./discord/api";
import { formatDiscordRuntimeContext } from "./discord/context";
import {
  DiscordDeliveryStore,
  type DiscordDeliveryChatInput,
  type DiscordDeliveryRecord,
  type DiscordDeliveryResetInput,
  type DiscordResetDeliveryRecord
} from "./discord/delivery";
import { inlineDataUrls } from "./discord/format";
import {
  createDiscordProgressReporter,
  withProgressTools
} from "./discord/progress";
import type { DiscordProgressReporter } from "./discord/progress";
import {
  clearDiscordSession,
  createAssistantHistoryText,
  createDiscordResponseFromAssistantMessage,
  createDiscordUserMessage,
  getDiscordMessageText,
  hydrateStoredResponseArtifacts,
  withAssistantText
} from "./discord/turn";
import type { DiscordChatRequest, DiscordChatResponse } from "./discord/types";
import { getErrorMessage, logError, logInfo, logWarn } from "./logging";
import { getGuildIdFromConversationName, GuildMemoryProvider } from "./memory";
import {
  CHAT_MODEL,
  COMPACTION_PROVIDER_OPTIONS,
  COMPACTION_TAIL_TOKEN_BUDGET,
  COMPACTION_TOKEN_THRESHOLD,
  REPLY_PROVIDER_OPTIONS
} from "./model";
import { createBaseSystemPrompt } from "./prompts";
import {
  createScheduledChannelTaskUserText,
  getScheduledChannelTaskPayload,
  SCHEDULED_CHANNEL_TASK_CALLBACK,
  summarizeScheduledChannelTask,
  type CancelScheduledChannelTaskResult,
  type ListScheduledChannelTasksResult,
  type ScheduleChannelTaskInput,
  type ScheduleChannelTaskResult,
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
import type { ScheduledTaskController } from "./tools/scheduled-tasks";
import { hasDiscordPermission } from "./discord/permissions";

const DISCORD_DEBUG_RESPONSE_TIMEOUT_MS = 14 * 60 * 1000;
const DISCORD_DEBUG_RESPONSE_POLL_MS = 100;
const DISCORD_DEFERRED_RESPONSE_SETTLE_MS = 500;
const HOUSEKEEPING_INTERVAL_SECONDS = 24 * 60 * 60;
const TERMINAL_SUBMISSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DISCORD_ACTIVE_TOOLS = ["codemode"];
const MIN_RECURRING_SCHEDULE_SECONDS = 60 * 60;

type DiscordUserMessageMetadata = {
  source?: unknown;
  interactionId?: unknown;
  guildId?: unknown;
  channelId?: unknown;
  channel?: unknown;
  appPermissions?: unknown;
  userId?: unknown;
  user?: unknown;
  userPermissions?: unknown;
};

export class ChatAgent extends Think<Env> {
  override sendReasoning = false;
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "codemode",
    name: () => this.name
  });

  private discordDeliveries = new DiscordDeliveryStore(this.ctx.storage);
  private progressReporters = new Map<string, DiscordProgressReporter>();
  private guildMemoryProvider?: GuildMemoryProvider;

  override getModel() {
    const workersai = createWorkersAI({ binding: this.env.AI });
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
      () => getGuildIdFromConversationName(this.name)
    );

    return session
      .withContext(GUILD_MEMORY_CONTEXT_LABEL, {
        description: GUILD_MEMORY_CONTEXT_DESCRIPTION,
        maxTokens: GUILD_MEMORY_CONTEXT_MAX_TOKENS,
        provider: this.guildMemoryProvider
      })
      .withCachedPrompt(createSessionContextPromptProvider(this))
      .onCompaction(
        createCompactFunction({
          summarize: async (prompt) => {
            const workersai = createWorkersAI({ binding: this.env.AI });
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

    return {
      system: createDiscordThinkSystemPrompt(
        sessionContext,
        turn ? formatDiscordRuntimeContext(turn) : undefined
      ),
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
      await this.failDiscordDelivery(
        record,
        result.error ?? `Think turn ended with status ${result.status}.`
      );
      return;
    }

    try {
      await this.deliverDiscordChatResponse(record, result);
    } catch (error) {
      await this.failDiscordDelivery(record, getErrorMessage(error));
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
      await this.deliverCompletedSubmissionWithoutResponse(record);
      return;
    }

    if (
      submission.status === "error" ||
      submission.status === "aborted" ||
      submission.status === "skipped"
    ) {
      await this.failDiscordDelivery(
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

    await this.processDiscordReset(record);
  }

  async runDebugQueuedDiscordChat(
    request: DiscordChatRequest
  ): Promise<DiscordChatResponse> {
    await this.enqueueDiscordChat({
      responseTarget: { type: "debug", id: request.interactionId },
      request
    });
    return this.waitForDebugQueuedResponse(request.interactionId);
  }

  async runDebugQueuedDiscordReset(
    input: Omit<DiscordDeliveryResetInput, "responseTarget">
  ): Promise<DiscordChatResponse> {
    await this.enqueueDiscordReset({
      ...input,
      responseTarget: { type: "debug", id: input.interactionId }
    });
    return this.waitForDebugQueuedResponse(input.interactionId);
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
      const [completedDeliveryRecords, staleDebugResults, terminalSubmissions] =
        await Promise.all([
          this.discordDeliveries.pruneCompletedDeliveryRecords(),
          this.discordDeliveries.pruneStaleDebugResults(),
          this.deleteSubmissions({
            status: ["completed", "aborted", "skipped", "error"],
            completedBefore: new Date(
              Date.now() - TERMINAL_SUBMISSION_RETENTION_MS
            ),
            limit: 100
          })
        ]);

      if (
        completedDeliveryRecords > 0 ||
        staleDebugResults > 0 ||
        terminalSubmissions > 0
      ) {
        logInfo("Discord housekeeping pruned stale records", {
          agentName: this.name,
          completedDeliveryRecords,
          staleDebugResults,
          terminalSubmissions
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
        }),
        ...(await this.session.tools())
      },
      progress
    );

    return {
      codemode: createDiscordCodeModeTool(this.env, directTools, this.workspace)
    };
  }

  private createScheduledTaskController(
    turn: DiscordChatRequest
  ): ScheduledTaskController {
    return {
      schedule: (input) => this.scheduleDiscordChannelTask(turn, input),
      list: () => this.listDiscordChannelTasks(turn),
      cancel: (scheduleId) => this.cancelDiscordChannelTask(turn, scheduleId)
    };
  }

  private async scheduleDiscordChannelTask(
    turn: DiscordChatRequest,
    input: ScheduleChannelTaskInput
  ): Promise<ScheduleChannelTaskResult> {
    const instruction = input.instruction.trim();
    if (!instruction) {
      return {
        ok: false,
        error: "Scheduled task instruction cannot be empty."
      };
    }

    if (!turn.guildId || !turn.channelId) {
      return {
        ok: false,
        error: "Scheduled tasks require a Discord guild channel context."
      };
    }

    const when = getScheduleWhen(input);
    if (!when.ok) return when;

    const payload = {
      kind: "discord_channel_task",
      taskId: crypto.randomUUID(),
      guildId: turn.guildId,
      channelId: turn.channelId,
      channel: turn.channel,
      appPermissions: turn.appPermissions,
      createdByUserId: turn.userId,
      createdByUser: turn.user,
      instruction,
      createdAt: new Date().toISOString()
    } satisfies ScheduledChannelTaskPayload;

    try {
      const schedule = await (input.mode === "interval" &&
      typeof when.value === "number"
        ? this.scheduleEvery(
            when.value,
            SCHEDULED_CHANNEL_TASK_CALLBACK,
            payload
          )
        : this.schedule(when.value, SCHEDULED_CHANNEL_TASK_CALLBACK, payload));

      return {
        ok: true,
        scheduleId: schedule.id,
        taskId: payload.taskId,
        type: schedule.type,
        nextRunAt: new Date(schedule.time * 1000).toISOString(),
        recurring: schedule.type === "cron" || schedule.type === "interval",
        instruction
      };
    } catch (error) {
      logError("Scheduled channel task creation failed", error, {
        agentName: this.name,
        guildId: turn.guildId,
        channelId: turn.channelId,
        mode: input.mode
      });
      return {
        ok: false,
        error: getErrorMessage(error)
      };
    }
  }

  private async listDiscordChannelTasks(
    turn: DiscordChatRequest
  ): Promise<ListScheduledChannelTasksResult> {
    try {
      const summaries = (await this.listSchedules())
        .map(summarizeScheduledChannelTask)
        .filter((summary) => summary !== undefined)
        .filter(
          (summary) => !turn.channelId || summary.channelId === turn.channelId
        )
        .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt));

      return {
        ok: true,
        schedules: summaries
      };
    } catch (error) {
      logError("Scheduled channel task listing failed", error, {
        agentName: this.name,
        guildId: turn.guildId,
        channelId: turn.channelId
      });
      return {
        ok: false,
        error: getErrorMessage(error)
      };
    }
  }

  private async cancelDiscordChannelTask(
    turn: DiscordChatRequest,
    scheduleId: string
  ): Promise<CancelScheduledChannelTaskResult> {
    const preparedScheduleId = scheduleId.trim();
    if (!preparedScheduleId) {
      return {
        ok: false,
        scheduleId,
        error: "Schedule ID cannot be empty."
      };
    }

    try {
      const schedule = await this.getScheduleById(preparedScheduleId);
      if (!schedule) {
        return {
          ok: true,
          scheduleId: preparedScheduleId,
          cancelled: false
        };
      }

      const payload = getScheduledChannelTaskPayload(schedule.payload);
      if (
        schedule.callback !== SCHEDULED_CHANNEL_TASK_CALLBACK ||
        !payload ||
        payload.channelId !== turn.channelId
      ) {
        return {
          ok: false,
          scheduleId: preparedScheduleId,
          error: "That schedule is not a scheduled task for this channel."
        };
      }

      const callerCreatedTask =
        Boolean(payload.createdByUserId) &&
        payload.createdByUserId === turn.userId;
      const callerCanManageMessages = hasDiscordPermission(
        turn.userPermissions,
        PermissionFlagsBits.ManageMessages
      );

      if (!callerCreatedTask && !callerCanManageMessages) {
        return {
          ok: false,
          scheduleId: preparedScheduleId,
          error:
            "Only the task creator or a caller with Manage Messages can cancel that scheduled task."
        };
      }

      return {
        ok: true,
        scheduleId: preparedScheduleId,
        cancelled: await this.cancelSchedule(preparedScheduleId)
      };
    } catch (error) {
      logError("Scheduled channel task cancellation failed", error, {
        agentName: this.name,
        guildId: turn.guildId,
        channelId: turn.channelId,
        scheduleId: preparedScheduleId
      });
      return {
        ok: false,
        scheduleId: preparedScheduleId,
        error: getErrorMessage(error)
      };
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

  private async deliverDiscordChatResponse(
    record: DiscordDeliveryRecord,
    result: ChatResponseResult
  ) {
    if (record.type !== "chat") return;

    const freshRecord =
      (await this.discordDeliveries.getDelivery(record.interactionId)) ??
      record;
    if (freshRecord.type !== "chat") return;

    const text = getDiscordMessageText(result.message);
    const artifacts = await hydrateStoredResponseArtifacts(
      this.env,
      freshRecord.artifacts
    );
    const historyText = createAssistantHistoryText(text, artifacts);
    if (historyText !== text) {
      try {
        await this.updateMessageInHistory(
          withAssistantText(result.message, historyText)
        );
      } catch (error) {
        logError("Discord assistant history update failed", error, {
          sequence: freshRecord.sequence,
          interactionId: freshRecord.interactionId
        });
      }
    }

    const response = createDiscordResponseFromAssistantMessage(text, artifacts);
    await this.deliverDiscordDeliveryResponse(freshRecord, response);
    await this.discordDeliveries.completeDelivery(freshRecord, "delivered");
  }

  private async deliverCompletedSubmissionWithoutResponse(
    record: DiscordDeliveryRecord
  ) {
    if (record.type !== "chat") return;

    try {
      const freshRecord =
        (await this.discordDeliveries.getDelivery(record.interactionId)) ??
        record;
      if (freshRecord.type !== "chat" || isTerminalDelivery(freshRecord)) {
        return;
      }

      const artifacts = await hydrateStoredResponseArtifacts(
        this.env,
        freshRecord.artifacts
      );
      const response = createDiscordResponseFromAssistantMessage("", artifacts);
      await this.deliverDiscordDeliveryResponse(freshRecord, response);
      await this.discordDeliveries.completeDelivery(freshRecord, "delivered");
    } catch (error) {
      await this.failDiscordDelivery(record, getErrorMessage(error));
    }
  }

  private async processDiscordReset(record: DiscordResetDeliveryRecord) {
    try {
      await this.discordDeliveries.markRunning(record.interactionId);
      const response = await clearDiscordSession({
        getPathLength: () => this.session.getPathLength(),
        clearMessages: () => this.clearMessagesAndStreams(),
        clearWorkspace: () => this.clearWorkspace()
      });
      await this.deliverDiscordDeliveryResponse(record, response);
      await this.discordDeliveries.completeDelivery(record, "delivered");
    } catch (error) {
      await this.failDiscordDelivery(record, getErrorMessage(error));
    } finally {
      await this.housekeeping();
    }
  }

  private async deliverDiscordDeliveryResponse(
    record: DiscordDeliveryRecord,
    response: DiscordChatResponse
  ) {
    if (record.responseTarget.type === "debug") {
      await this.discordDeliveries.putDebugResult(record.responseTarget.id, {
        status: "completed",
        response
      });
      return;
    }

    if (record.responseTarget.type === "channel_message") {
      logInfo("Sending Discord channel message", {
        sequence: record.sequence,
        interactionId: record.interactionId,
        channelId: record.responseTarget.channelId,
        contentLength: response.content.length,
        attachments: response.attachments?.length ?? 0
      });
      const messageCount = await deliverChannelMessage(
        this.env,
        record.responseTarget.channelId,
        response.content,
        response.attachments
      );
      logInfo("Sent Discord channel message", {
        sequence: record.sequence,
        interactionId: record.interactionId,
        channelId: record.responseTarget.channelId,
        contentLength: response.content.length,
        messageCount,
        attachments: response.attachments?.length ?? 0
      });
      return;
    }

    await waitForDiscordDeferredResponse(record);
    logInfo("Editing Discord interaction response", {
      sequence: record.sequence,
      interactionId: record.interactionId,
      contentLength: response.content.length,
      attachments: response.attachments?.length ?? 0
    });
    const messageCount = await deliverInteractionResponse(
      record.responseTarget,
      response.content,
      response.attachments
    );
    logInfo("Delivered Discord interaction response", {
      sequence: record.sequence,
      interactionId: record.interactionId,
      contentLength: response.content.length,
      messageCount,
      attachments: response.attachments?.length ?? 0
    });
  }

  private async failDiscordDelivery(
    record: DiscordDeliveryRecord,
    error: string
  ) {
    logError("Discord delivery failed", error, {
      sequence: record.sequence,
      interactionId: record.interactionId,
      deliveryType: record.type,
      responseTargetType: record.responseTarget.type
    });

    try {
      await this.deliverDiscordDeliveryFailure(record, error);
    } finally {
      this.progressReporters.delete(record.interactionId);
      await this.discordDeliveries.completeDelivery(record, "failed", error);
      await this.housekeeping();
    }
  }

  private async deliverDiscordDeliveryFailure(
    record: DiscordDeliveryRecord,
    error: string
  ) {
    if (record.responseTarget.type === "debug") {
      await this.discordDeliveries.putDebugResult(record.responseTarget.id, {
        status: "failed",
        error
      });
      return;
    }

    if (record.responseTarget.type === "channel_message") return;

    await waitForDiscordDeferredResponse(record);
    try {
      await editOriginalInteractionResponse(
        record.responseTarget,
        "Sorry, I could not complete that request."
      );
    } catch (editError) {
      logError("Discord failure response edit failed", editError, {
        sequence: record.sequence,
        interactionId: record.interactionId
      });
    }
  }

  private async waitForDebugQueuedResponse(targetId: string) {
    const deadline = Date.now() + DISCORD_DEBUG_RESPONSE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const result = await this.discordDeliveries.getDebugResult(targetId);
      if (!result) {
        await sleep(DISCORD_DEBUG_RESPONSE_POLL_MS);
        continue;
      }

      await this.discordDeliveries.deleteDebugResult(targetId);
      if (result.status === "failed") {
        throw new Error(result.error);
      }
      return result.response;
    }

    logWarn("Debug queued response timed out", {
      targetId,
      timeoutMs: DISCORD_DEBUG_RESPONSE_TIMEOUT_MS
    });
    throw new Error(`Debug queued response ${targetId} was not produced.`);
  }

  private getActiveProgressReporter() {
    const turn = this.getLatestDiscordTurn();
    return turn ? this.progressReporters.get(turn.interactionId) : undefined;
  }

  private getLatestDiscordTurn(): DiscordChatRequest | undefined {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index];
      if (message.role !== "user") continue;

      const metadata = message.metadata as DiscordUserMessageMetadata;
      if (metadata?.source !== "discord") continue;
      if (typeof metadata.interactionId !== "string") continue;

      return {
        interactionId: metadata.interactionId,
        text: "",
        guildId:
          typeof metadata.guildId === "string" ? metadata.guildId : undefined,
        channelId:
          typeof metadata.channelId === "string"
            ? metadata.channelId
            : undefined,
        channel: getDiscordChannelMetadata(metadata.channel),
        appPermissions: getDiscordPermissionMetadata(metadata.appPermissions),
        userId:
          typeof metadata.userId === "string" ? metadata.userId : undefined,
        user: getDiscordUserMetadata(metadata.user),
        userPermissions:
          typeof metadata.userPermissions === "string"
            ? metadata.userPermissions
            : undefined
      };
    }

    return undefined;
  }
}

function getDiscordUserMetadata(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const user = value as { id?: unknown; displayName?: unknown };
  if (typeof user.id !== "string") return undefined;
  return {
    id: user.id,
    displayName:
      typeof user.displayName === "string" ? user.displayName : undefined
  };
}

function getScheduleWhen(
  input: ScheduleChannelTaskInput
): { ok: true; value: Date | string | number } | { ok: false; error: string } {
  switch (input.mode) {
    case "delay": {
      const delaySeconds = getPositiveInteger(input.delaySeconds);
      if (!delaySeconds) {
        return {
          ok: false,
          error: "delaySeconds must be a positive integer when mode is delay."
        };
      }
      return { ok: true, value: delaySeconds };
    }
    case "at": {
      const runAt = input.runAt?.trim();
      if (!runAt) {
        return {
          ok: false,
          error: "runAt is required when mode is at."
        };
      }
      if (!hasIsoTimezone(runAt)) {
        return {
          ok: false,
          error:
            "runAt must include an explicit timezone offset or Z suffix, for example 2026-05-26T18:30:00-04:00."
        };
      }

      const date = new Date(runAt);
      if (!Number.isFinite(date.getTime())) {
        return {
          ok: false,
          error: "runAt must be a valid ISO 8601 timestamp."
        };
      }
      if (date.getTime() <= Date.now()) {
        return {
          ok: false,
          error: "runAt must be in the future."
        };
      }
      return { ok: true, value: date };
    }
    case "cron": {
      const cron = input.cron?.trim();
      if (!cron) {
        return {
          ok: false,
          error: "cron is required when mode is cron."
        };
      }
      if (cron.split(/\s+/).length !== 5) {
        return {
          ok: false,
          error:
            "cron must be a five-field expression: minute hour day month weekday."
        };
      }
      if (!isHourlyOrLessFrequentCron(cron)) {
        return {
          ok: false,
          error: "Recurring cron schedules cannot run more than once per hour."
        };
      }
      return { ok: true, value: cron };
    }
    case "interval": {
      const intervalSeconds = getPositiveInteger(input.intervalSeconds);
      if (!intervalSeconds) {
        return {
          ok: false,
          error:
            "intervalSeconds must be a positive integer when mode is interval."
        };
      }
      if (intervalSeconds < MIN_RECURRING_SCHEDULE_SECONDS) {
        return {
          ok: false,
          error: "intervalSeconds must be at least 3600 for recurring tasks."
        };
      }
      return { ok: true, value: intervalSeconds };
    }
  }
}

function getPositiveInteger(value: number | undefined) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function hasIsoTimezone(value: string) {
  return /(?:z|[+-]\d{2}:\d{2})$/i.test(value);
}

function isHourlyOrLessFrequentCron(cron: string) {
  const [minute, hour] = cron.split(/\s+/);
  if (!minute || !hour) return false;
  if (minute === "*" || minute.includes("/")) return false;
  if (hour.includes("/")) {
    const interval = Number(hour.split("/")[1]);
    if (Number.isFinite(interval) && interval < 1) return false;
  }
  return true;
}

function getDiscordChannelMetadata(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const channel = value as {
    id?: unknown;
    guildId?: unknown;
    name?: unknown;
    type?: unknown;
    typeName?: unknown;
    topic?: unknown;
    parentId?: unknown;
    nsfw?: unknown;
    slowmodeSeconds?: unknown;
  };
  if (typeof channel.id !== "string") return undefined;

  return {
    id: channel.id,
    guildId: typeof channel.guildId === "string" ? channel.guildId : undefined,
    name: typeof channel.name === "string" ? channel.name : undefined,
    type: typeof channel.type === "number" ? channel.type : undefined,
    typeName:
      typeof channel.typeName === "string" ? channel.typeName : undefined,
    topic: typeof channel.topic === "string" ? channel.topic : undefined,
    parentId:
      typeof channel.parentId === "string" ? channel.parentId : undefined,
    nsfw: typeof channel.nsfw === "boolean" ? channel.nsfw : undefined,
    slowmodeSeconds:
      typeof channel.slowmodeSeconds === "number"
        ? channel.slowmodeSeconds
        : undefined
  };
}

function getDiscordPermissionMetadata(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const permissions = value as { raw?: unknown; names?: unknown };
  if (typeof permissions.raw !== "string") return undefined;

  return {
    raw: permissions.raw,
    names: Array.isArray(permissions.names)
      ? permissions.names.filter((name) => typeof name === "string")
      : []
  };
}

function isTerminalDelivery(record: DiscordDeliveryRecord) {
  return record.status === "delivered" || record.status === "failed";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDiscordDeferredResponse(record: DiscordDeliveryRecord) {
  if (record.responseTarget.type !== "discord") return;

  const createdAtMs = Date.parse(record.createdAt);
  if (!Number.isFinite(createdAtMs)) return;

  const waitMs =
    DISCORD_DEFERRED_RESPONSE_SETTLE_MS - (Date.now() - createdAtMs);
  if (waitMs > 0) await sleep(waitMs);
}
