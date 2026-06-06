import type { WorkspaceFsLike } from "@cloudflare/shell";
import type { ArtifactEnv, ResponseArtifact } from "../artifacts";
import type {
  DiscordMessageSearchContext,
  DiscordMessageSearchEnv
} from "../discord-message-search";
import type { ImageEnv } from "../images";
import type { ModerationEnv, ModerationRequestContext } from "../moderation";
import type { NicknameEnv, NicknameRequestContext } from "../nickname";
import type { ScheduledTaskController } from "../scheduled-tasks";
import type { SearchEnv } from "../search";
import type { StickerEnv, StickerRequestContext } from "../stickers";
import { createArchiveTools } from "./archive";
import { createArtifactTools } from "./artifacts";
import { createRenderedPageTools, type BrowserEnv } from "./browser";
import { createDiscordCodeModeTool, type CodeModeEnv } from "./codemode";
import { createDiscordMessageSearchTools } from "./discord-message-search";
import { createImageTools } from "./images";
import { createModerationTools } from "./moderation";
import { createNicknameTools } from "./nickname";
import { createSearchTools } from "./search";
import { createScheduledTaskTools } from "./scheduled-tasks";
import { createStickerTools } from "./stickers";

export type ToolEnv = SearchEnv &
  DiscordMessageSearchEnv &
  ImageEnv &
  ArtifactEnv &
  ModerationEnv &
  NicknameEnv &
  StickerEnv &
  CodeModeEnv &
  BrowserEnv;

export type ToolOptions = {
  discordRequest?: NicknameRequestContext &
    ModerationRequestContext &
    DiscordMessageSearchContext &
    StickerRequestContext;
  scheduledTasks?: ScheduledTaskController;
  workspace?: WorkspaceFsLike;
  onArtifactCreated?: (artifact: ResponseArtifact) => void | Promise<void>;
};

export function createDiscordTools(env: ToolEnv, options: ToolOptions = {}) {
  return {
    ...createArchiveTools(),
    ...createSearchTools(env),
    ...createRenderedPageTools(env),
    ...createDiscordMessageSearchTools(env, options.discordRequest ?? {}),
    ...createNicknameTools(env, options.discordRequest ?? {}),
    ...createModerationTools(env, options.discordRequest ?? {}),
    ...createStickerTools(env, options.discordRequest ?? {}),
    ...createScheduledTaskTools(options.scheduledTasks),
    ...createImageTools(env, options),
    ...createArtifactTools(env, options.workspace, options)
  };
}

export { createDiscordCodeModeTool };
