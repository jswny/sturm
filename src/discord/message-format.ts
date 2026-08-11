import {
  ComponentType,
  type APIComponentInContainer,
  type APIMessage,
  type APIMessageSnapshot,
  type APIMessageTopLevelComponent,
  type APIPoll,
  type APIPollMedia
} from "discord-api-types/v10";
import { formatUtcTimestampField } from "./timestamps";
import type { DiscordAppContext } from "./types";

const SNAPSHOT_MESSAGE_MAX_CHARS = 700;

export type DiscordChannelMessage = Omit<APIMessage, "reactions">;

export type DiscordMessageFormatContext = {
  app?: DiscordAppContext;
  memberDisplayNames: Map<string, string>;
};

export type FormattedDiscordChannelMessage = {
  id: string;
  text: string;
};

export type DiscordRetrievedMessage = {
  id: string;
  formattedText: string;
  url: string;
};

type DiscordMessageBody = Pick<
  APIMessage,
  "attachments" | "components" | "content" | "embeds" | "sticker_items"
> &
  Partial<Pick<APIMessage, "message_snapshots" | "poll">>;

type DiscordMessageFormatOptions = DiscordMessageFormatContext & {
  currentInteractionId?: string;
  sturmMessageContent: "marker" | "full";
  maxBodyChars?: number;
  includeEmptyMessage: boolean;
};

export function formatDiscordMessageForSnapshot(
  message: DiscordChannelMessage,
  context: DiscordMessageFormatContext & { currentInteractionId?: string }
): FormattedDiscordChannelMessage | undefined {
  return formatDiscordMessage(message, {
    ...context,
    sturmMessageContent: "marker",
    maxBodyChars: SNAPSHOT_MESSAGE_MAX_CHARS,
    includeEmptyMessage: false
  });
}

export function formatDiscordMessageForRetrieval(
  message: DiscordChannelMessage,
  context: DiscordMessageFormatContext
): FormattedDiscordChannelMessage {
  return (
    formatDiscordMessage(message, {
      ...context,
      sturmMessageContent: "full",
      includeEmptyMessage: true
    }) ?? {
      id: message.id,
      text: formatMessageText(
        message,
        formatMessageAuthor(message, context.memberDisplayNames),
        "[message has no text or supported content]"
      )
    }
  );
}

export function createDiscordRetrievedMessage(
  guildId: string,
  message: DiscordChannelMessage,
  context: DiscordMessageFormatContext
): DiscordRetrievedMessage {
  const formatted = formatDiscordMessageForRetrieval(message, context);
  return {
    id: message.id,
    formattedText: formatted.text,
    url: `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`
  };
}

function formatDiscordMessage(
  message: DiscordChannelMessage,
  options: DiscordMessageFormatOptions
): FormattedDiscordChannelMessage | undefined {
  if (isCurrentSturmInteractionMessage(message, options)) return undefined;

  const isSturm = isSturmMessage(message, options.app);
  const author = formatMessageAuthor(
    message,
    options.memberDisplayNames,
    isSturm ? "Sturm" : undefined
  );
  if (isSturm && options.sturmMessageContent === "marker") {
    return {
      id: message.id,
      text: formatMessageText(
        message,
        author,
        "[assistant response omitted; see persisted assistant history]"
      )
    };
  }

  const fullBody = formatMessageBody(message);
  if (!fullBody && !options.includeEmptyMessage) return undefined;

  const body = options.maxBodyChars
    ? limitText(fullBody, options.maxBodyChars)
    : fullBody;
  return {
    id: message.id,
    text: formatMessageText(
      message,
      author,
      body || "[message has no text or supported content]"
    )
  };
}

function formatMessageText(
  message: DiscordChannelMessage,
  author: string,
  body: string
) {
  const prefix = `- ${formatMessageTimestamps(message)} ${author}: `;
  return `${prefix}${indentContinuationLines(body)}`;
}

function formatMessageTimestamps(message: DiscordChannelMessage) {
  return [
    formatUtcTimestampField("sent_at_utc", message.timestamp),
    message.edited_timestamp
      ? formatUtcTimestampField("edited_at_utc", message.edited_timestamp)
      : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function formatMessageAuthor(
  message: DiscordChannelMessage,
  memberDisplayNames: Map<string, string>,
  displayNameOverride?: string
) {
  const displayName =
    displayNameOverride ??
    memberDisplayNames.get(message.author.id) ??
    message.author.global_name ??
    message.author.username;
  const labels = [`id: ${message.author.id}`];
  if (message.author.bot) labels.push("bot");
  if (message.webhook_id) labels.push(`webhook_id: ${message.webhook_id}`);
  return `${displayName} (${labels.join(", ")})`;
}

function formatMessageBody(message: DiscordMessageBody) {
  const parts: string[] = [];
  const content = normalizeMessageContent(message.content);
  if (content) parts.push(content);
  if (message.attachments.length > 0) {
    parts.push(
      `attachments: ${message.attachments.map(formatAttachment).join(", ")}`
    );
  }
  if (message.embeds.length > 0) parts.push(`embeds: ${message.embeds.length}`);

  const componentText = collectMessageComponentText(message.components);
  if (componentText.length > 0) {
    parts.push(formatLabeledBlock("component_text", componentText.join("\n")));
  }

  if (message.sticker_items?.length) {
    parts.push(
      `stickers: ${message.sticker_items
        .map((sticker) => sticker.name)
        .join(", ")}`
    );
  }
  if (message.poll) parts.push(formatPoll(message.poll));
  if (message.message_snapshots?.length) {
    parts.push(
      ...message.message_snapshots.map((snapshot, index) =>
        formatMessageSnapshot(snapshot, index)
      )
    );
  }

  return parts.join("\n");
}

function normalizeMessageContent(content: string) {
  return content.replace(/\r\n?/g, "\n").trim();
}

function formatAttachment(
  attachment: DiscordMessageBody["attachments"][number]
) {
  const contentType = attachment.content_type
    ? ` ${attachment.content_type}`
    : "";
  return `${attachment.filename}${contentType}`;
}

function collectMessageComponentText(
  components: APIMessageTopLevelComponent[] | undefined
) {
  return (components ?? []).flatMap(collectComponentText);
}

function collectComponentText(
  component: APIMessageTopLevelComponent | APIComponentInContainer
): string[] {
  switch (component.type) {
    case ComponentType.TextDisplay: {
      const content = normalizeMessageContent(component.content);
      return content ? [content] : [];
    }
    case ComponentType.Section:
      return component.components.flatMap(collectComponentText);
    case ComponentType.Container:
      return component.components.flatMap(collectComponentText);
    default:
      return [];
  }
}

function formatPoll(poll: APIPoll) {
  const counts = new Map(
    poll.results?.answer_counts.map((answer) => [answer.id, answer.count]) ?? []
  );
  const answers = poll.answers.map((answer) => {
    const count = counts.get(answer.answer_id);
    return `${answer.answer_id}. ${formatPollMedia(answer.poll_media)}${
      count === undefined ? "" : ` (votes: ${count})`
    }`;
  });
  return [
    `poll_question: ${formatPollMedia(poll.question)}`,
    `poll_answers: ${answers.join("; ")}`,
    poll.allow_multiselect ? "poll_allows_multiple_answers: true" : undefined,
    poll.expiry
      ? formatUtcTimestampField("poll_expires_at_utc", poll.expiry)
      : undefined
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function formatPollMedia(media: APIPollMedia) {
  const emoji = media.emoji?.name ?? media.emoji?.id;
  return [emoji, media.text].filter(Boolean).join(" ") || "[no label]";
}

function formatMessageSnapshot(snapshot: APIMessageSnapshot, index: number) {
  const snapshotBody = formatMessageBody(snapshot.message);
  const details = [
    formatUtcTimestampField("sent_at_utc", snapshot.message.timestamp),
    snapshot.message.edited_timestamp
      ? formatUtcTimestampField(
          "edited_at_utc",
          snapshot.message.edited_timestamp
        )
      : undefined,
    snapshotBody || "[snapshot has no text or supported content]"
  ]
    .filter((line) => line !== undefined)
    .join("\n");
  return formatLabeledBlock(`message_snapshot_${index + 1}`, details);
}

function formatLabeledBlock(label: string, value: string) {
  return `${label}: ${indentContinuationLines(value)}`;
}

function indentContinuationLines(text: string) {
  return text
    .split("\n")
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join("\n");
}

function isCurrentSturmInteractionMessage(
  message: DiscordChannelMessage,
  options: DiscordMessageFormatOptions
) {
  return Boolean(
    options.currentInteractionId &&
    isSturmMessage(message, options.app) &&
    getMessageInteractionId(message) === options.currentInteractionId
  );
}

export function isSturmMessage(
  message: DiscordChannelMessage,
  app: DiscordAppContext | undefined
) {
  return Boolean(
    (app?.applicationId && message.application_id === app.applicationId) ||
    (app?.botUserId && message.author.id === app.botUserId)
  );
}

function getMessageInteractionId(message: DiscordChannelMessage) {
  return message.interaction_metadata?.id ?? message.interaction?.id;
}

function limitText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
