import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ComponentType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type APIAttachment,
  type APIChatInputApplicationCommandInteraction,
  type APIInteraction,
  type APIInteractionResponse,
  type APIMessageComponentInteraction
} from "discord-api-types/v10";
import { verifyKey } from "discord-interactions";
import { getAgentByName } from "agents";
import { editOriginalInteractionResponse } from "./discord/api";
import { C_COMMAND, MEMORY_COMMAND, RESET_COMMAND } from "./discord/commands";
import {
  parseComponentPromptCustomId,
  renderComponentPromptComponents,
  type ComponentPromptSelectionResult
} from "./discord/component-prompts";
import {
  getDiscordGuildChannelConversationName,
  type DiscordGuildChannelLocation
} from "./discord/conversation";
import { createDiscordRuntimeContext } from "./discord/context";
import { resolveDiscordMemberDisplayName } from "./discord/display-name";
import { normalizeDiscordMemberJoinedAt } from "./discord/user-context";
import { runMemoryCommand } from "./discord/memory-command";
import type {
  DiscordRequestAttachment,
  DiscordWebhookResponseTarget,
  DiscordUserContext
} from "./discord/types";
import { BodyTooLargeError, readRequestTextWithLimit } from "./http";
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

const DISCORD_INTERACTION_MAX_BYTES = 1024 * 1024;

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

  let body: string;
  try {
    body = await readRequestTextWithLimit(
      request,
      DISCORD_INTERACTION_MAX_BYTES
    );
  } catch (error) {
    if (!(error instanceof BodyTooLargeError)) throw error;
    logWarn("Discord interaction request was too large", {
      maxBytes: error.maxBytes
    });
    return json({ error: "Request body too large" }, { status: 413 });
  }
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

  if (isMessageComponentInteraction(interaction)) {
    return handleMessageComponentInteraction(interaction, env);
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

  if (interaction.data.name === MEMORY_COMMAND.name) {
    const location = getGuildChannelLocation(interaction);
    if (!location) {
      return guildOnlyInteractionResponse();
    }

    deferDiscordWork(ctx, interaction, "Discord /memory command failed", () =>
      runMemoryCommand(interaction, env, location.guildId)
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

async function handleMessageComponentInteraction(
  interaction: APIMessageComponentInteraction,
  env: Env
) {
  const parsed = parseComponentPromptCustomId(interaction.data.custom_id);
  if (!parsed) {
    return ephemeralInteractionResponse(
      "This component is no longer available."
    );
  }

  const location = getGuildChannelLocation(interaction);
  if (!location) return guildOnlyInteractionResponse();

  const optionId =
    parsed.mode === "select"
      ? getSelectedComponentOptionId(interaction)
      : parsed.optionId;
  if (!optionId) {
    return ephemeralInteractionResponse("That option is no longer available.");
  }

  const conversationName = getDiscordGuildChannelConversationName(location);
  const agent = await getAgentByName(env.ChatAgent, conversationName);
  try {
    const result = await agent.handleDiscordComponentPromptInteraction({
      promptId: parsed.promptId,
      optionId,
      interactionId: interaction.id,
      guildId: location.guildId,
      channelId: location.channelId,
      messageId: interaction.message.id,
      ...createDiscordRuntimeContext(interaction),
      userId: getUserId(interaction),
      user: getUserContext(interaction),
      userPermissions: interaction.member?.permissions
    });

    return interactionJson(createComponentPromptInteractionResponse(result));
  } catch (error) {
    logDiscordCommandError(
      "Discord component prompt handling failed",
      error,
      interaction
    );
    return ephemeralInteractionResponse(
      "Sorry, I could not handle that selection."
    );
  }
}

function createComponentPromptInteractionResponse(
  result: ComponentPromptSelectionResult
): APIInteractionResponse {
  switch (result.status) {
    case "accepted":
    case "already_handled":
    case "expired":
      return {
        type: InteractionResponseType.UpdateMessage,
        data: {
          allowed_mentions: { parse: [] },
          flags: MessageFlags.IsComponentsV2,
          components: renderComponentPromptComponents(result.prompt)
        }
      };
    case "wrong_user":
      return createEphemeralInteractionResponse(
        `This prompt is for <@${result.prompt.allowedUserId}>.`
      );
    case "wrong_context":
      return createEphemeralInteractionResponse(
        "This prompt is not available here."
      );
    case "invalid_option":
      return createEphemeralInteractionResponse(
        "That option is no longer available."
      );
    case "not_found":
      return createEphemeralInteractionResponse(
        "This prompt is no longer available."
      );
  }
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

function isMessageComponentInteraction(
  interaction: APIInteraction
): interaction is APIMessageComponentInteraction {
  return (
    interaction.type === InteractionType.MessageComponent &&
    typeof interaction.data?.custom_id === "string"
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
      correlationId: interaction.id,
      discordInteractionId: interaction.id,
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
    correlationId: interaction.id,
    discordInteractionId: interaction.id,
    guildId: location.guildId,
    channelId: location.channelId,
    userId: getUserId(interaction),
    user: getUserIdentityContext(interaction),
    responseTarget: getResponseTarget(interaction)
  });
  return agent;
}

type DiscordRoutedInteraction =
  | APIChatInputApplicationCommandInteraction
  | APIMessageComponentInteraction;

function getGuildChannelLocation(
  interaction: DiscordRoutedInteraction
): DiscordGuildChannelLocation | null {
  if (!interaction.guild_id || !interaction.channel_id) return null;
  return {
    guildId: interaction.guild_id,
    channelId: interaction.channel_id
  };
}

function getUserId(interaction: DiscordRoutedInteraction) {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

function getUserContext(
  interaction: DiscordRoutedInteraction
): DiscordUserContext | undefined {
  const user = interaction.member?.user ?? interaction.user;
  if (!user?.id) return undefined;

  return {
    id: user.id,
    displayName: interaction.member
      ? resolveDiscordMemberDisplayName(interaction.member)
      : undefined,
    roleIds: interaction.member?.roles.filter(
      (roleId): roleId is string =>
        typeof roleId === "string" && Boolean(roleId)
    ),
    joinedAtUtc: normalizeDiscordMemberJoinedAt(interaction.member?.joined_at)
  };
}

function getUserIdentityContext(
  interaction: DiscordRoutedInteraction
): DiscordUserContext | undefined {
  const user = getUserContext(interaction);
  if (!user) return undefined;
  return {
    id: user.id,
    displayName: user.displayName
  };
}

function getSelectedComponentOptionId(
  interaction: APIMessageComponentInteraction
) {
  if (
    interaction.data.component_type !== ComponentType.StringSelect ||
    !("values" in interaction.data)
  ) {
    return undefined;
  }

  return interaction.data.values[0];
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

function ephemeralInteractionResponse(content: string) {
  return interactionJson(createEphemeralInteractionResponse(content));
}

function createEphemeralInteractionResponse(
  content: string
): APIInteractionResponse {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: {
      content,
      flags: MessageFlags.Ephemeral,
      allowed_mentions: { parse: [] }
    }
  };
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
  interaction: DiscordRoutedInteraction
) {
  logError(message, error, {
    interactionId: interaction.id,
    applicationId: interaction.application_id,
    guildId: interaction.guild_id,
    channelId: interaction.channel_id,
    commandName:
      interaction.type === InteractionType.ApplicationCommand
        ? interaction.data.name
        : undefined,
    userId: getUserId(interaction)
  });
}
