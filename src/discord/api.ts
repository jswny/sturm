import type {
  RESTAPIPartialCurrentUserGuild,
  RESTGetAPIChannelMessagesResult,
  RESTGetAPICurrentUserGuildsResult,
  RESTGetAPIGuildMessagesSearchQuery,
  RESTGetAPIGuildMessagesSearchResult,
  RESTGetAPIGuildMemberResult,
  RESTGetAPIGuildMembersSearchResult,
  RESTPutAPIApplicationGuildCommandsJSONBody,
  RESTPutAPIApplicationGuildCommandsResult,
  RESTPostAPIChannelMessageJSONBody,
  RESTPostAPIGuildEmojiJSONBody,
  RESTPostAPIGuildEmojiResult,
  RESTPostAPIGuildStickerResult,
  RESTPatchAPIGuildMemberJSONBody,
  RESTPatchAPIGuildMemberResult,
  RESTPostAPIWebhookWithTokenJSONBody,
  RESTPatchAPIWebhookWithTokenMessageJSONBody
} from "discord-api-types/v10";
import type {
  DiscordResponseAttachment,
  DiscordWebhookResponseTarget
} from "./types";
import {
  getDiscordRestDispatcher,
  type DiscordRestFile,
  type DiscordRestRequest,
  type DiscordRestResult
} from "./rest-dispatcher";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const MAX_DISCORD_CONTENT_LENGTH = 2000;
const MIN_DISCORD_SPLIT_LENGTH = 1200;

export type DiscordApiEnv = Env & {
  DISCORD_TOKEN?: string;
  DiscordRest: DurableObjectNamespace<
    import("./rest-dispatcher").DiscordRestDispatcher
  >;
};

export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly code?: number,
    readonly retryable = false,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "DiscordApiError";
  }
}

export async function getChannelMessages(
  env: DiscordApiEnv,
  channelId: string,
  options: { limit: number; maxWaitMs?: number }
): Promise<RESTGetAPIChannelMessagesResult> {
  const params = new URLSearchParams({
    limit: String(clampDiscordMessageLimit(options.limit))
  });
  return discordApiFetch<RESTGetAPIChannelMessagesResult>(
    env,
    `/channels/${channelId}/messages?${params.toString()}`,
    { maxWaitMs: options.maxWaitMs }
  );
}

export async function editOriginalInteractionResponse(
  target: DiscordWebhookResponseTarget,
  content: string,
  attachments: DiscordResponseAttachment[] = []
) {
  const body = createDiscordResponseBody(content, attachments);
  const response = await fetch(
    `${DISCORD_API_BASE}/webhooks/${target.applicationId}/${target.token}/messages/@original`,
    {
      method: "PATCH",
      headers: body.headers,
      body: body.body
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new DiscordApiError(
      `Discord original response edit failed: ${response.status} ${body}`,
      response.status,
      body,
      getDiscordErrorCode(body)
    );
  }
}

export async function deliverInteractionResponse(
  target: DiscordWebhookResponseTarget,
  content: string,
  attachments: DiscordResponseAttachment[] = []
) {
  const chunks = splitDiscordContent(content);
  const [firstChunk = "", ...followupChunks] = chunks;

  await editOriginalInteractionResponse(target, firstChunk, attachments);
  for (const chunk of followupChunks) {
    await createInteractionFollowup(target, chunk);
  }

  return chunks.length;
}

export async function deliverChannelMessage(
  env: DiscordApiEnv,
  channelId: string,
  content: string,
  attachments: DiscordResponseAttachment[] = []
) {
  const chunks = splitDiscordContent(content);
  const [firstChunk = "", ...followupChunks] = chunks;

  await createChannelMessage(env, channelId, firstChunk, attachments);
  for (const chunk of followupChunks) {
    await createChannelMessage(env, channelId, chunk);
  }

  return chunks.length;
}

async function createInteractionFollowup(
  target: DiscordWebhookResponseTarget,
  content: string
) {
  const payload: RESTPostAPIWebhookWithTokenJSONBody = {
    content,
    allowed_mentions: { parse: [] }
  };
  const response = await fetch(
    `${DISCORD_API_BASE}/webhooks/${target.applicationId}/${target.token}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new DiscordApiError(
      `Discord followup response failed: ${response.status} ${body}`,
      response.status,
      body,
      getDiscordErrorCode(body)
    );
  }
}

async function createChannelMessage(
  env: DiscordApiEnv,
  channelId: string,
  content: string,
  attachments: DiscordResponseAttachment[] = []
) {
  const request = createDiscordRestMessageRequest(content, attachments);
  const result = await getDiscordRestDispatcher(env.DiscordRest).request({
    method: "POST",
    path: `/channels/${channelId}/messages`,
    ...request
  });

  if (!result.ok) {
    throw createDiscordApiError(result);
  }
}

export async function getGuildMember(
  env: DiscordApiEnv,
  guildId: string,
  userId: string,
  options: { maxWaitMs?: number; cache?: DiscordRestRequest["cache"] } = {}
): Promise<RESTGetAPIGuildMemberResult> {
  return discordApiFetch<RESTGetAPIGuildMemberResult>(
    env,
    `/guilds/${guildId}/members/${userId}`,
    { maxWaitMs: options.maxWaitMs, cache: options.cache }
  );
}

export async function searchGuildMembers(
  env: DiscordApiEnv,
  guildId: string,
  query: string,
  limit: number
): Promise<RESTGetAPIGuildMembersSearchResult> {
  const params = new URLSearchParams({
    query,
    limit: String(limit)
  });
  return discordApiFetch<RESTGetAPIGuildMembersSearchResult>(
    env,
    `/guilds/${guildId}/members/search?${params.toString()}`
  );
}

export async function searchGuildMessages(
  env: DiscordApiEnv,
  guildId: string,
  query: RESTGetAPIGuildMessagesSearchQuery,
  options: { maxWaitMs?: number } = {}
): Promise<RESTGetAPIGuildMessagesSearchResult> {
  const params = createDiscordGuildMessageSearchParams(query);
  return discordApiFetch<RESTGetAPIGuildMessagesSearchResult>(
    env,
    `/guilds/${guildId}/messages/search?${params.toString()}`,
    { maxWaitMs: options.maxWaitMs }
  );
}

export async function getCurrentUserGuilds(
  env: DiscordApiEnv
): Promise<RESTGetAPICurrentUserGuildsResult> {
  const guilds: RESTAPIPartialCurrentUserGuild[] = [];
  let after: string | undefined;

  while (true) {
    const query = new URLSearchParams({ limit: "200" });
    if (after) query.set("after", after);

    const page = await discordApiFetch<RESTGetAPICurrentUserGuildsResult>(
      env,
      `/users/@me/guilds?${query.toString()}`
    );
    guilds.push(...page);

    if (page.length < 200) return guilds;
    after = page.at(-1)?.id;
    if (!after) return guilds;
  }
}

export async function overwriteGuildApplicationCommands(
  env: DiscordApiEnv,
  applicationId: string,
  guildId: string,
  commands: RESTPutAPIApplicationGuildCommandsJSONBody
): Promise<RESTPutAPIApplicationGuildCommandsResult> {
  return discordApiFetch<RESTPutAPIApplicationGuildCommandsResult>(
    env,
    `/applications/${applicationId}/guilds/${guildId}/commands`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(commands)
    }
  );
}

export type CreateGuildEmojiInput = {
  name: string;
  image: string;
  reason?: string;
};

export async function createGuildEmoji(
  env: DiscordApiEnv,
  guildId: string,
  input: CreateGuildEmojiInput
): Promise<RESTPostAPIGuildEmojiResult> {
  const body: RESTPostAPIGuildEmojiJSONBody = {
    name: input.name,
    image: input.image
  };
  return discordApiFetch<RESTPostAPIGuildEmojiResult>(
    env,
    `/guilds/${guildId}/emojis`,
    {
      method: "POST",
      headers: createDiscordAuditLogHeaders(input.reason),
      body: JSON.stringify(body),
      maxWaitMs: 15_000
    }
  );
}

export type CreateGuildStickerInput = {
  name: string;
  description: string;
  tags: string;
  filename: string;
  mimeType: string;
  base64: string;
  reason?: string;
};

export async function createGuildSticker(
  env: DiscordApiEnv,
  guildId: string,
  input: CreateGuildStickerInput
): Promise<RESTPostAPIGuildStickerResult> {
  const result = await getDiscordRestDispatcher(env.DiscordRest).request({
    method: "POST",
    path: `/guilds/${guildId}/stickers`,
    headers: createDiscordAuditLogHeaders(input.reason),
    fields: [
      { name: "name", value: input.name },
      { name: "description", value: input.description },
      { name: "tags", value: input.tags }
    ],
    files: [
      {
        fieldName: "file",
        filename: input.filename,
        mimeType: input.mimeType,
        base64: input.base64
      }
    ],
    maxWaitMs: 15_000
  });

  if (!result.ok) {
    throw createDiscordApiError(result);
  }

  return JSON.parse(result.body) as RESTPostAPIGuildStickerResult;
}

export async function modifyGuildMemberNickname(
  env: DiscordApiEnv,
  guildId: string,
  userId: string,
  nick: string | null
): Promise<RESTPatchAPIGuildMemberResult> {
  const body: RESTPatchAPIGuildMemberJSONBody = { nick };
  return discordApiFetch<RESTPatchAPIGuildMemberResult>(
    env,
    `/guilds/${guildId}/members/${userId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }
  );
}

export async function modifyGuildMemberTimeout(
  env: DiscordApiEnv,
  guildId: string,
  userId: string,
  communicationDisabledUntil: string | null,
  reason?: string
): Promise<RESTPatchAPIGuildMemberResult> {
  const body: RESTPatchAPIGuildMemberJSONBody = {
    communication_disabled_until: communicationDisabledUntil
  };
  return discordApiFetch<RESTPatchAPIGuildMemberResult>(
    env,
    `/guilds/${guildId}/members/${userId}`,
    {
      method: "PATCH",
      headers: createDiscordAuditLogHeaders(reason),
      body: JSON.stringify(body)
    }
  );
}

type DiscordApiFetchInit = RequestInit & {
  maxWaitMs?: number;
  cache?: DiscordRestRequest["cache"];
};

async function discordApiFetch<T>(
  env: DiscordApiEnv,
  path: string,
  init: DiscordApiFetchInit = {}
): Promise<T> {
  const result = await getDiscordRestDispatcher(env.DiscordRest).request({
    method: init.method ?? "GET",
    path,
    headers: normalizeHeaders(init.headers),
    body: typeof init.body === "string" ? init.body : undefined,
    maxWaitMs: init.maxWaitMs,
    cache: init.cache
  });

  if (!result.ok) {
    throw createDiscordApiError(result);
  }

  return JSON.parse(result.body) as T;
}

function normalizeHeaders(headers: HeadersInit | undefined) {
  if (!headers) return undefined;

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return headers;
}

function clampDiscordMessageLimit(limit: number) {
  if (!Number.isFinite(limit)) return 50;
  return Math.min(100, Math.max(1, Math.trunc(limit)));
}

function createDiscordGuildMessageSearchParams(
  query: RESTGetAPIGuildMessagesSearchQuery
) {
  const params = new URLSearchParams();
  appendOptionalParam(params, "limit", query.limit);
  appendOptionalParam(params, "offset", query.offset);
  appendOptionalParam(params, "max_id", query.max_id);
  appendOptionalParam(params, "min_id", query.min_id);
  appendOptionalParam(params, "slop", query.slop);
  appendOptionalParam(params, "content", query.content);
  appendRepeatedParam(params, "channel_id", query.channel_id);
  appendRepeatedParam(params, "author_type", query.author_type);
  appendRepeatedParam(params, "author_id", query.author_id);
  appendRepeatedParam(params, "mentions", query.mentions);
  appendRepeatedParam(params, "mentions_role_id", query.mentions_role_id);
  appendOptionalParam(params, "mention_everyone", query.mention_everyone);
  appendRepeatedParam(params, "replied_to_user_id", query.replied_to_user_id);
  appendRepeatedParam(
    params,
    "replied_to_message_id",
    query.replied_to_message_id
  );
  appendOptionalParam(params, "pinned", query.pinned);
  appendRepeatedParam(params, "has", query.has);
  appendRepeatedParam(params, "embed_type", query.embed_type);
  appendRepeatedParam(params, "embed_provider", query.embed_provider);
  appendRepeatedParam(params, "link_hostname", query.link_hostname);
  appendRepeatedParam(params, "attachment_filename", query.attachment_filename);
  appendRepeatedParam(
    params,
    "attachment_extension",
    query.attachment_extension
  );
  appendOptionalParam(params, "sort_by", query.sort_by);
  appendOptionalParam(params, "sort_order", query.sort_order);
  appendOptionalParam(params, "include_nsfw", query.include_nsfw);
  return params;
}

function appendOptionalParam(
  params: URLSearchParams,
  key: string,
  value: string | number | boolean | undefined
) {
  if (value === undefined) return;
  params.set(key, String(value));
}

function appendRepeatedParam(
  params: URLSearchParams,
  key: string,
  values: readonly (string | number | boolean)[] | undefined
) {
  for (const value of values ?? []) {
    params.append(key, String(value));
  }
}

function createDiscordAuditLogHeaders(reason: string | undefined) {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };
  const preparedReason = reason?.trim();
  if (preparedReason) {
    headers["x-audit-log-reason"] = encodeURIComponent(
      preparedReason.slice(0, 160)
    );
  }
  return headers;
}

function createDiscordApiError(
  result: Extract<DiscordRestResult, { ok: false }>
) {
  return new DiscordApiError(
    result.error,
    result.status ?? 0,
    result.body ?? "",
    result.code,
    result.retryable,
    result.retryAfterMs
  );
}

function createDiscordResponseBody(
  content: string,
  attachments: DiscordResponseAttachment[]
) {
  assertDiscordContentLength(content);
  const payload = createDiscordMessagePayload(content, attachments);

  if (attachments.length === 0) {
    return {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    };
  }

  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  for (const [index, attachment] of attachments.entries()) {
    form.append(
      `files[${index}]`,
      new File([base64ToBytes(attachment.base64)], attachment.filename, {
        type: attachment.mimeType
      })
    );
  }

  return { headers: undefined, body: form };
}

function createDiscordRestMessageRequest(
  content: string,
  attachments: DiscordResponseAttachment[]
) {
  assertDiscordContentLength(content);
  const payload = createDiscordMessagePayload(content, attachments);
  const body = JSON.stringify(payload);

  if (attachments.length === 0) {
    return {
      headers: { "content-type": "application/json" },
      body
    };
  }

  return {
    body,
    files: attachments.map(
      (attachment, index) =>
        ({
          fieldName: `files[${index}]`,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          base64: attachment.base64
        }) satisfies DiscordRestFile
    )
  };
}

function createDiscordMessagePayload(
  content: string,
  attachments: DiscordResponseAttachment[]
):
  | RESTPatchAPIWebhookWithTokenMessageJSONBody
  | RESTPostAPIChannelMessageJSONBody {
  return {
    content,
    allowed_mentions: { parse: [] },
    attachments: attachments.map((attachment, index) => ({
      id: String(index),
      filename: attachment.filename,
      description: attachment.description
    }))
  };
}

function base64ToBytes(base64: string) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export function splitDiscordContent(content: string) {
  if (content.length <= MAX_DISCORD_CONTENT_LENGTH) {
    return content ? [content] : [""];
  }

  const chunks: string[] = [];
  let remaining = content.trim();

  while (remaining.length > MAX_DISCORD_CONTENT_LENGTH) {
    const splitIndex = findDiscordSplitIndex(remaining);
    const chunk = remaining.slice(0, splitIndex).trimEnd();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining || chunks.length === 0) chunks.push(remaining);
  return chunks;
}

function findDiscordSplitIndex(content: string) {
  const limit = Math.min(content.length, MAX_DISCORD_CONTENT_LENGTH);
  const candidate = content.slice(0, limit);
  for (const separator of ["\n\n", "\n", ". ", " "]) {
    const index = candidate.lastIndexOf(separator);
    if (index >= MIN_DISCORD_SPLIT_LENGTH) {
      return index + separator.length;
    }
  }
  return limit;
}

function assertDiscordContentLength(content: string) {
  if (content.length > MAX_DISCORD_CONTENT_LENGTH) {
    throw new Error(
      `Discord message content exceeds ${MAX_DISCORD_CONTENT_LENGTH} characters.`
    );
  }
}

function getDiscordErrorCode(body: string) {
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === "number" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}
