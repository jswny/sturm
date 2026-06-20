import { Liquid } from "liquidjs";
import { toUnixTimestampSeconds } from "./timestamps";

const DISCORD_RESPONSE_OUTPUT_DELIMITER_LEFT = "[[";
const DISCORD_RESPONSE_OUTPUT_DELIMITER_RIGHT = "]]";
const DISCORD_RESPONSE_TAG_DELIMITER_LEFT = "[%";
const DISCORD_RESPONSE_TAG_DELIMITER_RIGHT = "%]";
const DISCORD_RESPONSE_TEMPLATE_PARSE_LIMIT = 20_000;
const DISCORD_RESPONSE_TEMPLATE_RENDER_LIMIT_MS = 100;

const DISCORD_TIMESTAMP_STYLES = new Set([
  "t",
  "T",
  "d",
  "D",
  "f",
  "F",
  "s",
  "S",
  "R"
]);

type DiscordResponseTemplateRenderResult = {
  content: string;
  rendered: boolean;
  error?: string;
};

const discordResponseRenderer = createDiscordResponseRenderer();

export function renderDiscordResponseTemplate(
  content: string
): DiscordResponseTemplateRenderResult {
  if (!content.includes(DISCORD_RESPONSE_OUTPUT_DELIMITER_LEFT)) {
    return { content, rendered: false };
  }

  try {
    const rendered = String(
      discordResponseRenderer.parseAndRenderSync(content)
    );
    return { content: rendered, rendered: rendered !== content };
  } catch (error) {
    return {
      content,
      rendered: false,
      error: getErrorMessage(error)
    };
  }
}

function createDiscordResponseRenderer() {
  const renderer = new Liquid({
    outputDelimiterLeft: DISCORD_RESPONSE_OUTPUT_DELIMITER_LEFT,
    outputDelimiterRight: DISCORD_RESPONSE_OUTPUT_DELIMITER_RIGHT,
    tagDelimiterLeft: DISCORD_RESPONSE_TAG_DELIMITER_LEFT,
    tagDelimiterRight: DISCORD_RESPONSE_TAG_DELIMITER_RIGHT,
    strictFilters: true,
    strictVariables: true,
    ownPropertyOnly: true,
    dynamicPartials: false,
    relativeReference: false,
    templates: {},
    parseLimit: DISCORD_RESPONSE_TEMPLATE_PARSE_LIMIT,
    renderLimit: DISCORD_RESPONSE_TEMPLATE_RENDER_LIMIT_MS
  });

  renderer.registerFilter(
    "discordTimestamp",
    (timestamp: unknown, style: unknown = "R") => {
      const timestampText =
        typeof timestamp === "string" ? timestamp : String(timestamp);
      if (!hasExplicitIsoTimezone(timestampText)) {
        throw new Error(
          "discordTimestamp requires an ISO 8601 timestamp with explicit timezone."
        );
      }

      const unixTimestampSeconds = toUnixTimestampSeconds(timestampText);
      if (unixTimestampSeconds === undefined) {
        throw new Error("discordTimestamp received an invalid timestamp.");
      }

      return `<t:${unixTimestampSeconds}:${normalizeDiscordTimestampStyle(style)}>`;
    }
  );

  return renderer;
}

function normalizeDiscordTimestampStyle(style: unknown) {
  const styleText = typeof style === "string" ? style : String(style);
  if (!DISCORD_TIMESTAMP_STYLES.has(styleText)) {
    throw new Error(`Unsupported Discord timestamp style: ${styleText}`);
  }
  return styleText;
}

function hasExplicitIsoTimezone(timestamp: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
    timestamp
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
