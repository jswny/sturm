import type { WorkspaceFsLike } from "@cloudflare/shell";
import type { ArtifactEnv, ResponseArtifact } from "../artifacts";
import type {
  DiscordMessageHistoryContext,
  DiscordMessageHistoryEnv
} from "../discord-message-history";
import type {
  DiscordMessageSearchContext,
  DiscordMessageSearchEnv
} from "../discord-message-search";
import type { EmojiEnv, EmojiRequestContext } from "../emojis";
import type { ImageEnv } from "../images";
import type { ModerationEnv, ModerationRequestContext } from "../moderation";
import type { NicknameEnv, NicknameRequestContext } from "../nickname";
import type { ScheduledTaskController } from "../scheduled-tasks";
import type { SearchEnv } from "../search";
import type { StickerEnv, StickerRequestContext } from "../stickers";
import { createArchiveTools } from "./archive";
import { createArtifactTools } from "./artifacts";
import { createBrowserAutomationTools } from "./browser";
import { createDiscordMessageHistoryTools } from "./discord-message-history";
import { createDiscordMessageSearchTools } from "./discord-message-search";
import { createEmojiTools } from "./emojis";
import { createImageTools } from "./images";
import { createModerationTools } from "./moderation";
import { createNicknameTools } from "./nickname";
import { createSearchTools } from "./search";
import { createScheduledTaskTools } from "./scheduled-tasks";
import { createStickerTools } from "./stickers";
import {
  createUserPromptTools,
  type UserPromptController
} from "./user-prompts";

export type ToolEnv = SearchEnv &
  DiscordMessageHistoryEnv &
  DiscordMessageSearchEnv &
  ImageEnv &
  ArtifactEnv &
  ModerationEnv &
  NicknameEnv &
  EmojiEnv &
  StickerEnv;

export type ToolOptions = {
  discordRequest?: NicknameRequestContext &
    ModerationRequestContext &
    DiscordMessageHistoryContext &
    DiscordMessageSearchContext &
    EmojiRequestContext &
    StickerRequestContext;
  recentChannelBeforeMessageId?: string;
  discordBotUserId?: string;
  scheduledTasks?: ScheduledTaskController;
  userPrompts?: UserPromptController;
  workspace?: WorkspaceFsLike;
  onArtifactCreated?: (artifact: ResponseArtifact) => void | Promise<void>;
};

export function createDiscordTools(env: ToolEnv, options: ToolOptions = {}) {
  const discordToolContext = {
    ...(options.discordRequest ?? {}),
    app: {
      ...options.discordRequest?.app,
      botUserId:
        options.discordBotUserId ?? options.discordRequest?.app?.botUserId
    }
  };

  return {
    ...createArchiveTools(),
    ...createSearchTools(env),
    ...createDiscordMessageHistoryTools(env, {
      ...discordToolContext,
      initialBeforeMessageId: options.recentChannelBeforeMessageId
    }),
    ...createDiscordMessageSearchTools(env, discordToolContext),
    ...createNicknameTools(env, options.discordRequest ?? {}),
    ...createModerationTools(env, options.discordRequest ?? {}),
    ...createEmojiTools(env, options.discordRequest ?? {}),
    ...createStickerTools(env, options.discordRequest ?? {}),
    ...createScheduledTaskTools(options.scheduledTasks),
    ...createUserPromptTools(options.userPrompts),
    ...createImageTools(env, options),
    ...createArtifactTools(env, options.workspace, options)
  };
}

export { createBrowserAutomationTools };
