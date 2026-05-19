import { getAgentByName } from "agents";

export type DiscordChatRequest = {
  interactionId: string;
  text: string;
  guildId?: string;
  channelId?: string;
  userId?: string;
  user?: DiscordUserContext;
};

export type DiscordChatResponse = {
  content: string;
  attachments?: DiscordResponseAttachment[];
};

export type DiscordResponseTarget = {
  applicationId: string;
  token: string;
};

export type DiscordResponseAttachment = {
  filename: string;
  mimeType: string;
  base64: string;
  description?: string;
};

export type DiscordUserContext = {
  id: string;
  displayName?: string;
};

type DiscordEnv = Env & {
  DISCORD_PUBLIC_KEY?: string;
};

type DiscordInteraction = {
  id: string;
  application_id: string;
  token: string;
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: {
    nick?: string;
    user?: {
      id: string;
      username?: string;
      global_name?: string | null;
    };
  };
  user?: {
    id: string;
    username?: string;
    global_name?: string | null;
  };
  data?: {
    name?: string;
    options?: DiscordCommandOption[];
  };
};

type DiscordCommandOption = {
  name: string;
  type: number;
  value?: string | number | boolean;
};

const DISCORD_API_BASE = "https://discord.com/api/v10";
const MAX_DISCORD_CONTENT_LENGTH = 2000;
const EPHEMERAL_MESSAGE_FLAG = 1 << 6;

const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2
} as const;

const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5
} as const;

export const C_COMMAND = {
  name: "c",
  description: "Chat with Sturm",
  type: 1,
  options: [
    {
      name: "text",
      description: "Text to send to Sturm",
      type: 3,
      required: true
    }
  ]
} as const;

export const RESET_COMMAND = {
  name: "reset",
  description: "Reset context for this channel or DM",
  type: 1,
  // Manage Messages. DMs are still allowed through command contexts.
  default_member_permissions: "8192"
} as const;

export async function handleDiscordRequest(
  request: Request,
  env: DiscordEnv
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/discord" && url.pathname !== "/discord/") return null;

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await request.text();
  const verified = await verifyDiscordRequest(request, body, env);
  if (!verified) {
    return new Response("Bad request signature.", { status: 401 });
  }

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(body) as DiscordInteraction;
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (interaction.type === InteractionType.PING) {
    return json({ type: InteractionResponseType.PONG });
  }

  if (interaction.type !== InteractionType.APPLICATION_COMMAND) {
    return json(
      {
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: "Unsupported interaction.",
          allowed_mentions: { parse: [] }
        }
      },
      { status: 200 }
    );
  }

  if (interaction.data?.name === C_COMMAND.name) {
    const text = getStringOption(interaction, "text");
    if (!text) {
      return json(
        {
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "Missing text.",
            allowed_mentions: { parse: [] }
          }
        },
        { status: 200 }
      );
    }

    await enqueueCommand(interaction, text, env);

    return json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    });
  }

  if (interaction.data?.name === RESET_COMMAND.name) {
    await enqueueResetCommand(interaction, env);

    return json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: EPHEMERAL_MESSAGE_FLAG }
    });
  }

  return json(
    {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Unknown command.",
        allowed_mentions: { parse: [] }
      }
    },
    { status: 200 }
  );
}

async function enqueueCommand(
  interaction: DiscordInteraction,
  text: string,
  env: Env
) {
  const conversationName = getConversationName(interaction);
  const agent = await getAgentByName(env.ChatAgent, conversationName);
  await agent.enqueueDiscordChat({
    responseTarget: getResponseTarget(interaction),
    request: {
      interactionId: interaction.id,
      text,
      guildId: interaction.guild_id,
      channelId: interaction.channel_id,
      userId: getUserId(interaction),
      user: getUserContext(interaction)
    }
  });
}

async function enqueueResetCommand(interaction: DiscordInteraction, env: Env) {
  const conversationName = getConversationName(interaction);
  const agent = await getAgentByName(env.ChatAgent, conversationName);
  await agent.enqueueDiscordReset({
    interactionId: interaction.id,
    guildId: interaction.guild_id,
    channelId: interaction.channel_id,
    userId: getUserId(interaction),
    user: getUserContext(interaction),
    responseTarget: getResponseTarget(interaction)
  });
}

function getConversationName(interaction: DiscordInteraction) {
  if (interaction.guild_id && interaction.channel_id) {
    return `discord:guild:${interaction.guild_id}:channel:${interaction.channel_id}`;
  }

  if (!interaction.guild_id) {
    const userId = getUserId(interaction);
    if (userId) return `discord:dm:${userId}`;
  }

  throw new Error("Discord interaction did not include a usable location.");
}

function getUserId(interaction: DiscordInteraction) {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

function getUserContext(
  interaction: DiscordInteraction
): DiscordUserContext | undefined {
  const user = interaction.member?.user ?? interaction.user;
  if (!user?.id) return undefined;

  return {
    id: user.id,
    displayName:
      interaction.member?.nick ?? user.global_name ?? user.username ?? undefined
  };
}

function getStringOption(interaction: DiscordInteraction, name: string) {
  const option = interaction.data?.options?.find((item) => item.name === name);
  return typeof option?.value === "string" ? option.value.trim() : "";
}

function getResponseTarget(
  interaction: DiscordInteraction
): DiscordResponseTarget {
  return {
    applicationId: interaction.application_id,
    token: interaction.token
  };
}

export async function editOriginalInteractionResponse(
  target: DiscordResponseTarget,
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
    throw new Error(
      `Discord original response edit failed: ${response.status} ${body}`
    );
  }
}

function createDiscordResponseBody(
  content: string,
  attachments: DiscordResponseAttachment[]
) {
  const payload = {
    content: truncateDiscordContent(content),
    allowed_mentions: { parse: [] },
    attachments: attachments.map((attachment, index) => ({
      id: index,
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

async function verifyDiscordRequest(
  request: Request,
  body: string,
  env: DiscordEnv
) {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signature || !timestamp || !env.DISCORD_PUBLIC_KEY) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(env.DISCORD_PUBLIC_KEY),
      "Ed25519",
      false,
      ["verify"]
    );
    const signedData = new TextEncoder().encode(`${timestamp}${body}`);

    return await crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signature),
      signedData
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex: string) {
  if (hex.length % 2 !== 0 || !/^[\da-f]+$/i.test(hex)) {
    throw new Error("Invalid hex string");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function truncateDiscordContent(content: string) {
  if (content.length <= MAX_DISCORD_CONTENT_LENGTH) return content;
  return `${content.slice(0, MAX_DISCORD_CONTENT_LENGTH - 3)}...`;
}

function json(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });
}
