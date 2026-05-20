import type { GeneratedImage, ImageEnv } from "../images";
import type { NicknameEnv, NicknameRequestContext } from "../nickname";
import type { SearchEnv } from "../search";
import { createArchiveTools } from "./archive";
import { createImageTools } from "./images";
import { createNicknameTools } from "./nickname";
import { createSearchTools } from "./search";

export type ToolEnv = SearchEnv & ImageEnv & NicknameEnv;

export type ToolOptions = {
  discordRequest?: NicknameRequestContext;
  onImageGenerated?: (artifact: GeneratedImage) => void;
};

export function createDiscordTools(env: ToolEnv, options: ToolOptions = {}) {
  return {
    ...createArchiveTools(),
    ...createSearchTools(env),
    ...createNicknameTools(env, options.discordRequest ?? {}),
    ...createImageTools(env, options)
  };
}
