import type { ChatResponseResult } from "@cloudflare/think";
import type { UIMessage } from "ai";
import {
  deliverChannelMessage,
  deliverInteractionResponse,
  editOriginalInteractionResponse
} from "./api";
import {
  DiscordDeliveryStore,
  getDeliveryCorrelationId,
  isTerminalDelivery,
  type DiscordDeliveryRecord,
  type DiscordResetDeliveryRecord
} from "./delivery";
import {
  createAssistantHistoryText,
  createDiscordResponseFromAssistantMessage,
  getDiscordMessageText,
  hydrateStoredResponseArtifacts,
  withAssistantText
} from "./turn";
import { renderDiscordResponseTemplate } from "./response-template";
import {
  createComponentPromptResponse,
  formatComponentPromptHistoryText,
  type DiscordComponentPromptStore
} from "./component-prompts";
import type { DiscordChatResponse } from "./types";
import { getErrorMessage, logError, logInfo, logWarn } from "../logging";

const DISCORD_DEBUG_RESPONSE_TIMEOUT_MS = 14 * 60 * 1000;
const DISCORD_DEBUG_RESPONSE_POLL_MS = 100;
const DISCORD_DEFERRED_RESPONSE_SETTLE_MS = 500;

export type DiscordDeliveryRunnerOptions = {
  env: Env;
  deliveries: DiscordDeliveryStore;
  componentPrompts: DiscordComponentPromptStore;
  updateMessageInHistory(message: UIMessage): Promise<void>;
  resetSession(): Promise<DiscordChatResponse>;
  afterFailedDelivery?(record: DiscordDeliveryRecord): Promise<void> | void;
  afterReset?(record: DiscordResetDeliveryRecord): Promise<void> | void;
};

type DiscordDeliveryFailureOptions = {
  userMessage?: string;
};

export class DiscordDeliveryRunner {
  constructor(private options: DiscordDeliveryRunnerOptions) {}

  async deliverChatResponse(
    record: DiscordDeliveryRecord,
    result: ChatResponseResult
  ) {
    if (record.type !== "chat") return;
    const correlationId = getDeliveryCorrelationId(record);

    const freshRecord =
      (await this.options.deliveries.getDelivery(correlationId)) ?? record;
    if (freshRecord.type !== "chat") return;

    const text = getDiscordMessageText(result.message);
    const artifacts = await hydrateStoredResponseArtifacts(
      this.options.env,
      freshRecord.artifacts
    );
    if (shouldSuppressEmptyResponse(freshRecord, text, artifacts)) {
      logInfo("Skipped empty Discord channel response", {
        sequence: freshRecord.sequence,
        ...getDeliveryLogContext(freshRecord),
        responseTargetType: freshRecord.responseTarget.type
      });
      await this.options.deliveries.completeDelivery(freshRecord, "delivered");
      return;
    }

    const componentPrompt = freshRecord.componentPromptId
      ? await this.options.componentPrompts.get(freshRecord.componentPromptId)
      : undefined;
    const historyText = [
      createAssistantHistoryText(text, artifacts),
      componentPrompt ? formatComponentPromptHistoryText(componentPrompt) : ""
    ]
      .filter(Boolean)
      .join("\n\n");
    if (historyText !== text) {
      try {
        await this.options.updateMessageInHistory(
          withAssistantText(result.message, historyText)
        );
      } catch (error) {
        logError("Discord assistant history update failed", error, {
          sequence: freshRecord.sequence,
          ...getDeliveryLogContext(freshRecord)
        });
      }
    }

    const renderedText = renderDiscordResponseTemplate(text);
    if (renderedText.error) {
      logWarn("Discord response template render failed", {
        sequence: freshRecord.sequence,
        ...getDeliveryLogContext(freshRecord),
        error: renderedText.error
      });
    }

    const response = componentPrompt
      ? {
          ...createDiscordResponseFromAssistantMessage(
            renderedText.content,
            artifacts
          ),
          ...createComponentPromptResponse(componentPrompt)
        }
      : createDiscordResponseFromAssistantMessage(
          renderedText.content,
          artifacts
        );
    await this.deliverResponse(freshRecord, response);
    await this.options.deliveries.completeDelivery(freshRecord, "delivered");
  }

  async deliverCompletedSubmissionWithoutResponse(
    record: DiscordDeliveryRecord
  ) {
    if (record.type !== "chat") return;

    try {
      const correlationId = getDeliveryCorrelationId(record);
      const freshRecord =
        (await this.options.deliveries.getDelivery(correlationId)) ?? record;
      if (freshRecord.type !== "chat" || isTerminalDelivery(freshRecord)) {
        return;
      }

      const artifacts = await hydrateStoredResponseArtifacts(
        this.options.env,
        freshRecord.artifacts
      );
      if (shouldSuppressEmptyResponse(freshRecord, "", artifacts)) {
        logInfo("Skipped empty completed Discord submission response", {
          sequence: freshRecord.sequence,
          ...getDeliveryLogContext(freshRecord),
          responseTargetType: freshRecord.responseTarget.type
        });
        await this.options.deliveries.completeDelivery(
          freshRecord,
          "delivered"
        );
        return;
      }

      const response = createDiscordResponseFromAssistantMessage("", artifacts);
      await this.deliverResponse(freshRecord, response);
      await this.options.deliveries.completeDelivery(freshRecord, "delivered");
    } catch (error) {
      await this.failDelivery(record, getErrorMessage(error));
    }
  }

  async processReset(record: DiscordResetDeliveryRecord) {
    try {
      await this.options.deliveries.markRunning(
        getDeliveryCorrelationId(record)
      );
      const response = await this.options.resetSession();
      await this.deliverResponse(record, response);
      await this.options.deliveries.completeDelivery(record, "delivered");
    } catch (error) {
      await this.failDelivery(record, getErrorMessage(error));
    } finally {
      await this.options.afterReset?.(record);
    }
  }

  async failDelivery(
    record: DiscordDeliveryRecord,
    error: string,
    options: DiscordDeliveryFailureOptions = {}
  ) {
    logError("Discord delivery failed", error, {
      sequence: record.sequence,
      ...getDeliveryLogContext(record),
      deliveryType: record.type,
      responseTargetType: record.responseTarget.type
    });

    try {
      await this.deliverFailure(record, error, options);
    } finally {
      await this.options.deliveries.completeDelivery(record, "failed", error);
      await this.options.afterFailedDelivery?.(record);
    }
  }

  async waitForDebugQueuedResponse(targetId: string) {
    const deadline = Date.now() + DISCORD_DEBUG_RESPONSE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const result = await this.options.deliveries.getDebugResult(targetId);
      if (!result) {
        await sleep(DISCORD_DEBUG_RESPONSE_POLL_MS);
        continue;
      }

      await this.options.deliveries.deleteDebugResult(targetId);
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

  private async deliverResponse(
    record: DiscordDeliveryRecord,
    response: DiscordChatResponse
  ) {
    if (record.responseTarget.type === "debug") {
      await this.options.deliveries.putDebugResult(record.responseTarget.id, {
        status: "completed",
        response
      });
      return;
    }

    if (record.responseTarget.type === "channel_message") {
      logInfo("Sending Discord channel message", {
        sequence: record.sequence,
        ...getDeliveryLogContext(record),
        channelId: record.responseTarget.channelId,
        contentLength: response.content.length,
        attachments: response.attachments?.length ?? 0
      });
      const messageCount = await deliverChannelMessage(
        this.options.env,
        record.responseTarget.channelId,
        response.content,
        response.attachments,
        response.components,
        response.flags
      );
      logInfo("Sent Discord channel message", {
        sequence: record.sequence,
        ...getDeliveryLogContext(record),
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
      ...getDeliveryLogContext(record),
      contentLength: response.content.length,
      attachments: response.attachments?.length ?? 0
    });
    const messageCount = await deliverInteractionResponse(
      record.responseTarget,
      response.content,
      response.attachments,
      response.components,
      response.flags
    );
    logInfo("Delivered Discord interaction response", {
      sequence: record.sequence,
      ...getDeliveryLogContext(record),
      contentLength: response.content.length,
      messageCount,
      attachments: response.attachments?.length ?? 0
    });
  }

  private async deliverFailure(
    record: DiscordDeliveryRecord,
    error: string,
    options: DiscordDeliveryFailureOptions
  ) {
    if (record.responseTarget.type === "debug") {
      await this.options.deliveries.putDebugResult(record.responseTarget.id, {
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
        options.userMessage ?? "Sorry, I could not complete that request."
      );
    } catch (editError) {
      logError("Discord failure response edit failed", editError, {
        sequence: record.sequence,
        ...getDeliveryLogContext(record)
      });
    }
  }
}

function getDeliveryLogContext(record: DiscordDeliveryRecord) {
  return {
    correlationId: getDeliveryCorrelationId(record),
    discordInteractionId: record.discordInteractionId
  };
}

async function waitForDiscordDeferredResponse(record: DiscordDeliveryRecord) {
  const readyAt =
    Date.parse(record.createdAt) + DISCORD_DEFERRED_RESPONSE_SETTLE_MS;
  const delayMs = readyAt - Date.now();
  if (delayMs > 0) await sleep(delayMs);
}

function shouldSuppressEmptyResponse(
  record: DiscordDeliveryRecord,
  text: string,
  artifacts: unknown[]
) {
  return (
    record.type === "chat" &&
    record.request.emptyResponseBehavior === "suppress" &&
    text.trim().length === 0 &&
    artifacts.length === 0
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
