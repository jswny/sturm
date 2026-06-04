export type DiscordGuildMemberTarget = {
  guildId: string;
  userId: string;
};

export function getDiscordRestRouteKey(method: string, path: string) {
  const pathname = path.split("?")[0] ?? path;
  const parts = pathname.split("/").map((part, index, all) => {
    if (isMajorResourceId(index, all)) return part;
    if (isWebhookToken(index, all)) return ":webhookToken";
    if (/^\d+$/.test(part)) return ":id";
    return part;
  });
  return `${method.toUpperCase()} ${parts.join("/")}`;
}

export function getDiscordRestMajorResourceKey(path: string) {
  const parts = getPathParts(path);
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index];
    const id = parts[index + 1];
    if (part === "channels") return `channel:${id}`;
    if (part === "guilds") return `guild:${id}`;
    if (part === "webhooks") {
      const token = parts[index + 2];
      return token ? `webhook:${id}:${stableHash(token)}` : `webhook:${id}`;
    }
  }

  return "none";
}

export function getDiscordRestBucketRateLimitKey(
  majorResourceKey: string,
  bucket: string
) {
  return `bucket:${majorResourceKey}:${bucket}`;
}

export function getDiscordGuildMemberTarget(
  method: string,
  path: string
): DiscordGuildMemberTarget | undefined {
  if (method !== "GET" && method !== "PATCH") return undefined;

  const parts = getPathParts(path);
  const [guilds, guildId, members, userId, extra] = parts;
  if (
    guilds !== "guilds" ||
    members !== "members" ||
    extra !== undefined ||
    !guildId ||
    !userId ||
    !isDiscordSnowflake(guildId) ||
    !isDiscordSnowflake(userId)
  ) {
    return undefined;
  }

  return { guildId, userId };
}

export function getDiscordGuildMemberSearchGuildId(
  method: string,
  path: string
) {
  if (method !== "GET") return undefined;

  const parts = getPathParts(path);
  const [guilds, guildId, members, search, extra] = parts;
  if (
    guilds !== "guilds" ||
    members !== "members" ||
    search !== "search" ||
    extra !== undefined ||
    !guildId ||
    !isDiscordSnowflake(guildId)
  ) {
    return undefined;
  }

  return guildId;
}

export function isDiscordSnowflake(value: string) {
  return /^\d{8,}$/.test(value);
}

function getPathParts(path: string) {
  const pathname = path.split("?")[0] ?? path;
  return pathname.split("/").filter(Boolean);
}

function isMajorResourceId(index: number, parts: string[]) {
  return ["channels", "guilds", "webhooks"].includes(parts[index - 1] ?? "");
}

function isWebhookToken(index: number, parts: string[]) {
  return parts[index - 2] === "webhooks";
}

function stableHash(input: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
