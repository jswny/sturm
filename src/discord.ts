import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type APIChatInputApplicationCommandInteraction,
  type APIInteraction,
  type APIInteractionResponse,
  type RESTPostAPIChatInputApplicationCommandsJSONBody
} from "discord-api-types/v10";
import { verifyKey } from "discord-interactions";
import { getAgentByName } from "agents";
import type {
  DiscordResponseTarget,
  DiscordUserContext
} from "./discord/types";
import { logWarn } from "./logging";

export type {
  DiscordChatRequest,
  DiscordChatResponse,
  DiscordResponseAttachment,
  DiscordResponseTarget,
  DiscordUserContext
} from "./discord/types";
export { editOriginalInteractionResponse } from "./discord/api";

type DiscordEnv = Env & {
  DISCORD_PUBLIC_KEY?: string;
};

export const C_COMMAND = {
  name: "c",
  description: "Chat with Sturm",
  type: ApplicationCommandType.ChatInput,
  options: [
    {
      name: "text",
      description: "Text to send to Sturm",
      type: ApplicationCommandOptionType.String,
      required: true
    }
  ]
} as const satisfies RESTPostAPIChatInputApplicationCommandsJSONBody;

export const RESET_COMMAND = {
  name: "reset",
  description: "Reset context for this channel or DM",
  type: ApplicationCommandType.ChatInput,
  // Manage Messages. DMs are still allowed through command contexts.
  default_member_permissions: "8192"
} as const satisfies RESTPostAPIChatInputApplicationCommandsJSONBody;

export async function handleDiscordRequest(
  request: Request,
  env: DiscordEnv,
  ctx: ExecutionContext
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/discord" && url.pathname !== "/discord/") return null;

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await request.text();
  const verified = await verifyDiscordRequest(request, body, env);
  if (!verified) {
    logWarn("Discord request verification failed", {
      hasSignature: request.headers.has("x-signature-ed25519"),
      hasTimestamp: request.headers.has("x-signature-timestamp"),
      hasPublicKey: Boolean(env.DISCORD_PUBLIC_KEY)
    });
    return new Response("Bad request signature.", { status: 401 });
  }

  let interaction: APIInteraction;
  try {
    interaction = JSON.parse(body) as APIInteraction;
  } catch (error) {
    logWarn("Discord interaction JSON parse failed", {
      bodyLength: body.length,
      error: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (interaction.type === InteractionType.Ping) {
    return interactionJson({ type: InteractionResponseType.Pong });
  }

  if (interaction.type !== InteractionType.ApplicationCommand) {
    return interactionJson(
      {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
          content: "Unsupported interaction.",
          allowed_mentions: { parse: [] }
        }
      },
      { status: 200 }
    );
  }

  if (!isChatInputApplicationCommandInteraction(interaction)) {
    return interactionJson(
      {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
          content: "Unsupported command type.",
          allowed_mentions: { parse: [] }
        }
      },
      { status: 200 }
    );
  }

  if (interaction.data.name === C_COMMAND.name) {
    const text = getStringOption(interaction, "text");
    if (!text) {
      return interactionJson(
        {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: "Missing text.",
            allowed_mentions: { parse: [] }
          }
        },
        { status: 200 }
      );
    }

    const agent = await enqueueCommand(interaction, text, env);
    ctx.waitUntil(agent.processDiscordQueue());

    return interactionJson({
      type: InteractionResponseType.DeferredChannelMessageWithSource
    });
  }

  if (interaction.data.name === RESET_COMMAND.name) {
    const agent = await enqueueResetCommand(interaction, env);
    ctx.waitUntil(agent.processDiscordQueue());

    return interactionJson({
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral }
    });
  }

  return interactionJson(
    {
      type: InteractionResponseType.ChannelMessageWithSource,
      data: {
        content: "Unknown command.",
        allowed_mentions: { parse: [] }
      }
    },
    { status: 200 }
  );
}

function isChatInputApplicationCommandInteraction(
  interaction: APIInteraction
): interaction is APIChatInputApplicationCommandInteraction {
  return (
    interaction.type === InteractionType.ApplicationCommand &&
    interaction.data.type === ApplicationCommandType.ChatInput
  );
}

async function enqueueCommand(
  interaction: APIChatInputApplicationCommandInteraction,
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
      user: getUserContext(interaction),
      userPermissions: interaction.member?.permissions
    }
  });
  return agent;
}

async function enqueueResetCommand(
  interaction: APIChatInputApplicationCommandInteraction,
  env: Env
) {
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
  return agent;
}

function getConversationName(
  interaction: APIChatInputApplicationCommandInteraction
) {
  if (interaction.guild_id && interaction.channel_id) {
    return `discord:guild:${interaction.guild_id}:channel:${interaction.channel_id}`;
  }

  if (!interaction.guild_id) {
    const userId = getUserId(interaction);
    if (userId) return `discord:dm:${userId}`;
  }

  throw new Error("Discord interaction did not include a usable location.");
}

function getUserId(interaction: APIChatInputApplicationCommandInteraction) {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

function getUserContext(
  interaction: APIChatInputApplicationCommandInteraction
): DiscordUserContext | undefined {
  const user = interaction.member?.user ?? interaction.user;
  if (!user?.id) return undefined;

  return {
    id: user.id,
    displayName:
      interaction.member?.nick ?? user.global_name ?? user.username ?? undefined
  };
}

function getStringOption(
  interaction: APIChatInputApplicationCommandInteraction,
  name: string
) {
  const option = interaction.data?.options?.find((item) => item.name === name);
  if (option?.type !== ApplicationCommandOptionType.String) return "";
  return option.value.trim();
}

function getResponseTarget(
  interaction: APIChatInputApplicationCommandInteraction
): DiscordResponseTarget {
  return {
    type: "discord",
    applicationId: interaction.application_id,
    token: interaction.token
  };
}

async function verifyDiscordRequest(
  request: Request,
  body: string,
  env: DiscordEnv
) {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signature || !timestamp || !env.DISCORD_PUBLIC_KEY) return false;

  return verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);
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

function interactionJson(body: APIInteractionResponse, init?: ResponseInit) {
  return json(body, init);
}
