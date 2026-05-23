import type { WorkspaceLike } from "@cloudflare/think";

export function createDisabledWorkspace(): WorkspaceLike {
  return {
    readFile: async () => null,
    readFileBytes: async () => null,
    writeFile: async () => {
      throw new Error("Think workspace tools are disabled for Sturm.");
    },
    readDir: async () => [],
    rm: async () => {
      throw new Error("Think workspace tools are disabled for Sturm.");
    },
    glob: async () => [],
    mkdir: async () => {
      throw new Error("Think workspace tools are disabled for Sturm.");
    },
    stat: async () => null
  };
}
