import type { GeneratedImage, ImageEnv } from "../images";
import type { SearchEnv } from "../search";
import { createImageTools } from "./images";
import { createSearchTools } from "./search";

export type ToolEnv = SearchEnv & ImageEnv;

export type ToolOptions = {
  onImageGenerated?: (artifact: GeneratedImage) => void;
};

export function createDiscordTools(env: ToolEnv, options: ToolOptions = {}) {
  return {
    ...createSearchTools(env),
    ...createImageTools(env, options)
  };
}
