import type {
  RESTAPIPartialCurrentUserGuild,
  RESTGetAPICurrentUserGuildsResult,
  RESTGetAPIGuildMemberResult,
  RESTPutAPIApplicationGuildCommandsJSONBody,
  RESTPutAPIApplicationGuildCommandsResult,
  RESTPatchAPIGuildMemberJSONBody,
  RESTPatchAPIGuildMemberResult,
  RESTPatchAPIWebhookWithTokenMessageJSONBody
} from "discord-api-types/v10";
import type {
  DiscordResponseAttachment,
  DiscordWebhookResponseTarget
} from "./types";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const MAX_DISCORD_CONTENT_LENGTH = 2000;

export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly code?: number
  ) {
    super(message);
    this.name = "DiscordApiError";
  }
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

export async function getGuildMember(
  token: string,
  guildId: string,
  userId: string
): Promise<RESTGetAPIGuildMemberResult> {
  return discordApiFetch<RESTGetAPIGuildMemberResult>(
    `/guilds/${guildId}/members/${userId}`,
    token
  );
}

export async function getCurrentUserGuilds(
  token: string
): Promise<RESTGetAPICurrentUserGuildsResult> {
  const guilds: RESTAPIPartialCurrentUserGuild[] = [];
  let after: string | undefined;

  while (true) {
    const query = new URLSearchParams({ limit: "200" });
    if (after) query.set("after", after);

    const page = await discordApiFetch<RESTGetAPICurrentUserGuildsResult>(
      `/users/@me/guilds?${query.toString()}`,
      token
    );
    guilds.push(...page);

    if (page.length < 200) return guilds;
    after = page.at(-1)?.id;
    if (!after) return guilds;
  }
}

export async function overwriteGuildApplicationCommands(
  token: string,
  applicationId: string,
  guildId: string,
  commands: RESTPutAPIApplicationGuildCommandsJSONBody
): Promise<RESTPutAPIApplicationGuildCommandsResult> {
  return discordApiFetch<RESTPutAPIApplicationGuildCommandsResult>(
    `/applications/${applicationId}/guilds/${guildId}/commands`,
    token,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(commands)
    }
  );
}

export async function modifyGuildMemberNickname(
  token: string,
  guildId: string,
  userId: string,
  nick: string | null
): Promise<RESTPatchAPIGuildMemberResult> {
  const body: RESTPatchAPIGuildMemberJSONBody = { nick };
  return discordApiFetch<RESTPatchAPIGuildMemberResult>(
    `/guilds/${guildId}/members/${userId}`,
    token,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }
  );
}

async function discordApiFetch<T>(
  path: string,
  token: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bot ${token}`,
      ...init.headers
    }
  });

  const body = await response.text();
  if (!response.ok) {
    throw new DiscordApiError(
      `Discord API request failed: ${response.status} ${body}`,
      response.status,
      body,
      getDiscordErrorCode(body)
    );
  }

  return JSON.parse(body) as T;
}

function createDiscordResponseBody(
  content: string,
  attachments: DiscordResponseAttachment[]
) {
  const payload: RESTPatchAPIWebhookWithTokenMessageJSONBody = {
    content: truncateDiscordContent(content),
    allowed_mentions: { parse: [] },
    attachments: attachments.map((attachment, index) => ({
      id: String(index),
      filename: attachment.filename,
      description: attachment.description
    }))
  };

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

function base64ToBytes(base64: string) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function truncateDiscordContent(content: string) {
  if (content.length <= MAX_DISCORD_CONTENT_LENGTH) return content;
  return `${content.slice(0, MAX_DISCORD_CONTENT_LENGTH - 3)}...`;
}

function getDiscordErrorCode(body: string) {
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === "number" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}
