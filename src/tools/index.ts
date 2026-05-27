import type { WorkspaceFsLike } from "@cloudflare/shell";
import type { ArtifactEnv, ResponseArtifact } from "../artifacts";
import type { ImageEnv } from "../images";
import type { NicknameEnv, NicknameRequestContext } from "../nickname";
import type { ScheduledTaskController } from "./scheduled-tasks";
import type { SearchEnv } from "../search";
import { createArchiveTools } from "./archive";
import { createArtifactTools } from "./artifacts";
import { createRenderedPageTools, type BrowserEnv } from "./browser";
import { createDiscordCodeModeTool, type CodeModeEnv } from "./codemode";
import { createImageTools } from "./images";
import { createNicknameTools } from "./nickname";
import { createSearchTools } from "./search";
import { createScheduledTaskTools } from "./scheduled-tasks";

export type ToolEnv = SearchEnv &
  ImageEnv &
  ArtifactEnv &
  NicknameEnv &
  CodeModeEnv &
  BrowserEnv;

export type ToolOptions = {
  discordRequest?: NicknameRequestContext;
  scheduledTasks?: ScheduledTaskController;
  workspace?: WorkspaceFsLike;
  onArtifactCreated?: (artifact: ResponseArtifact) => void | Promise<void>;
};

export function createDiscordTools(env: ToolEnv, options: ToolOptions = {}) {
  return {
    ...createArchiveTools(),
    ...createSearchTools(env),
    ...createRenderedPageTools(env),
    ...createNicknameTools(env, options.discordRequest ?? {}),
    ...createScheduledTaskTools(options.scheduledTasks),
    ...createImageTools(env, options),
    ...createArtifactTools(env, options.workspace, options)
  };
}

export { createDiscordCodeModeTool };
