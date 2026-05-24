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
import { createWorkersAI } from "workers-ai-provider";
import {
  deliverInteractionResponse,
  editOriginalInteractionResponse
} from "./discord/api";
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
  hydrateStoredGeneratedImages,
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
  createDiscordThinkSystemPrompt,
  createSessionContextPromptProvider,
  getFreshSessionContextPrompt,
  GUILD_MEMORY_CONTEXT_DESCRIPTION,
  GUILD_MEMORY_CONTEXT_LABEL,
  GUILD_MEMORY_CONTEXT_MAX_TOKENS
} from "./session-context";
import { createDiscordCodeModeTool, createDiscordTools } from "./tools";

const DISCORD_DEBUG_RESPONSE_TIMEOUT_MS = 14 * 60 * 1000;
const DISCORD_DEBUG_RESPONSE_POLL_MS = 100;
const DISCORD_DEFERRED_RESPONSE_SETTLE_MS = 500;
const HOUSEKEEPING_INTERVAL_SECONDS = 24 * 60 * 60;
const TERMINAL_SUBMISSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DISCORD_ACTIVE_TOOLS = ["codemode"];

type DiscordUserMessageMetadata = {
  source?: unknown;
  interactionId?: unknown;
  guildId?: unknown;
  channelId?: unknown;
  userId?: unknown;
  user?: unknown;
  userPermissions?: unknown;
};

export class ChatAgent extends Think<Env> {
  override maxSteps = 5;
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
      system: createDiscordThinkSystemPrompt(sessionContext),
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
          onImageGenerated: async (artifact) => {
            if (!turn?.interactionId) return;
            await this.discordDeliveries.addGeneratedImage(
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

  private async clearWorkspace() {
    const entries = await this.workspace.readDir("/");
    await Promise.all(
      entries.map((entry) =>
        this.workspace.rm(entry.path, { recursive: true, force: true })
      )
    );
    return entries.length;
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
    const artifacts = await hydrateStoredGeneratedImages(
      this.env,
      freshRecord.generatedImages
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

      const artifacts = await hydrateStoredGeneratedImages(
        this.env,
        freshRecord.generatedImages
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
        clearMessages: () => this.clearMessages(),
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
