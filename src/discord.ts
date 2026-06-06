import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type APIAttachment,
  type APIChatInputApplicationCommandInteraction,
  type APIInteraction,
  type APIInteractionResponse
} from "discord-api-types/v10";
import { verifyKey } from "discord-interactions";
import { getAgentByName } from "agents";
import { editOriginalInteractionResponse } from "./discord/api";
import { C_COMMAND, RESET_COMMAND } from "./discord/commands";
import {
  getDiscordGuildChannelConversationName,
  type DiscordGuildChannelLocation
} from "./discord/conversation";
import { createDiscordRuntimeContext } from "./discord/context";
import { resolveDiscordMemberDisplayName } from "./discord/display-name";
import type {
  DiscordWebhookResponseTarget,
  DiscordRequestAttachment,
  DiscordUserContext
} from "./discord/types";
import { logError, logWarn } from "./logging";

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

    if (!getGuildChannelLocation(interaction)) {
      return guildOnlyInteractionResponse();
    }

    deferDiscordWork(ctx, interaction, "Discord /c enqueue failed", () =>
      enqueueCommand(interaction, text, env)
    );

    return interactionJson({
      type: InteractionResponseType.DeferredChannelMessageWithSource
    });
  }

  if (interaction.data.name === RESET_COMMAND.name) {
    if (!getGuildChannelLocation(interaction)) {
      return guildOnlyInteractionResponse();
    }

    deferDiscordWork(ctx, interaction, "Discord /reset enqueue failed", () =>
      enqueueResetCommand(interaction, env)
    );

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

function deferDiscordWork(
  ctx: ExecutionContext,
  interaction: APIChatInputApplicationCommandInteraction,
  failureLogMessage: string,
  work: () => Promise<unknown>
) {
  ctx.waitUntil(
    (async () => {
      try {
        await work();
      } catch (error) {
        logDiscordCommandError(failureLogMessage, error, interaction);
        await deliverDeferredInteractionFailure(interaction);
      }
    })()
  );
}

async function deliverDeferredInteractionFailure(
  interaction: APIChatInputApplicationCommandInteraction
) {
  try {
    await editOriginalInteractionResponse(
      getResponseTarget(interaction),
      "Sorry, I could not queue that request."
    );
  } catch (error) {
    logDiscordCommandError(
      "Discord deferred enqueue failure response failed",
      error,
      interaction
    );
  }
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
  const location = getGuildChannelLocation(interaction);
  if (!location) {
    throw new Error("Discord interaction did not include a guild channel.");
  }

  const conversationName = getDiscordGuildChannelConversationName(location);
  const agent = await getAgentByName(env.ChatAgent, conversationName);
  await agent.enqueueDiscordChat({
    responseTarget: getResponseTarget(interaction),
    request: {
      interactionId: interaction.id,
      text,
      guildId: location.guildId,
      channelId: location.channelId,
      ...createDiscordRuntimeContext(interaction),
      attachments: getAttachmentOption(interaction, "image"),
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
  const location = getGuildChannelLocation(interaction);
  if (!location) {
    throw new Error("Discord interaction did not include a guild channel.");
  }

  const conversationName = getDiscordGuildChannelConversationName(location);
  const agent = await getAgentByName(env.ChatAgent, conversationName);
  await agent.enqueueDiscordReset({
    interactionId: interaction.id,
    guildId: location.guildId,
    channelId: location.channelId,
    userId: getUserId(interaction),
    user: getUserContext(interaction),
    responseTarget: getResponseTarget(interaction)
  });
  return agent;
}

function getGuildChannelLocation(
  interaction: APIChatInputApplicationCommandInteraction
): DiscordGuildChannelLocation | null {
  if (!interaction.guild_id || !interaction.channel_id) return null;
  return {
    guildId: interaction.guild_id,
    channelId: interaction.channel_id
  };
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
    displayName: interaction.member
      ? resolveDiscordMemberDisplayName(interaction.member)
      : undefined
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

function getAttachmentOption(
  interaction: APIChatInputApplicationCommandInteraction,
  name: string
): DiscordRequestAttachment[] | undefined {
  const option = interaction.data?.options?.find((item) => item.name === name);
  if (option?.type !== ApplicationCommandOptionType.Attachment) {
    return undefined;
  }

  const attachment =
    interaction.data.resolved?.attachments?.[String(option.value)];
  if (!attachment) return undefined;

  return [createRequestAttachment(attachment)];
}

function createRequestAttachment(
  attachment: APIAttachment
): DiscordRequestAttachment {
  return {
    id: attachment.id,
    filename: attachment.title ?? attachment.filename,
    mimeType: attachment.content_type,
    sizeBytes: attachment.size,
    url: attachment.url,
    proxyUrl: attachment.proxy_url,
    width: attachment.width ?? undefined,
    height: attachment.height ?? undefined,
    description: attachment.description
  };
}

function getResponseTarget(
  interaction: APIChatInputApplicationCommandInteraction
): DiscordWebhookResponseTarget {
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

  try {
    return verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);
  } catch (error) {
    logError("Discord request verification threw", error, {
      hasSignature: Boolean(signature),
      hasTimestamp: Boolean(timestamp),
      hasPublicKey: Boolean(env.DISCORD_PUBLIC_KEY)
    });
    return false;
  }
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

function guildOnlyInteractionResponse() {
  return interactionJson(
    {
      type: InteractionResponseType.ChannelMessageWithSource,
      data: {
        content: "Sturm only works in server channels right now.",
        allowed_mentions: { parse: [] }
      }
    },
    { status: 200 }
  );
}

function logDiscordCommandError(
  message: string,
  error: unknown,
  interaction: APIChatInputApplicationCommandInteraction
) {
  logError(message, error, {
    interactionId: interaction.id,
    applicationId: interaction.application_id,
    guildId: interaction.guild_id,
    channelId: interaction.channel_id,
    commandName: interaction.data.name,
    userId: getUserId(interaction)
  });
}
