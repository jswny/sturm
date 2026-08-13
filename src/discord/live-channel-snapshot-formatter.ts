import {
  formatDiscordMessageForSnapshot,
  isSturmMessage
} from "./message-format";
import type { LiveDiscordChannelSnapshot } from "./live-channel-snapshot";

const LIVE_CHANNEL_SNAPSHOT_MAX_CHARS = 6_000;

export type FormattedLiveDiscordChannelSnapshot = {
  text: string;
  oldestVisibleMessageId?: string;
  newestVisibleNonSturmMessageId?: string;
};

export function formatLiveDiscordChannelSnapshot(
  snapshot: LiveDiscordChannelSnapshot | undefined
): FormattedLiveDiscordChannelSnapshot {
  if (!snapshot) return { text: "" };

  const entries = snapshot.messages
    .map((message) => {
      const entry = formatDiscordMessageForSnapshot(
        message,
        snapshot.formatContext
      );
      return entry
        ? {
            ...entry,
            isSturm: isSturmMessage(message, snapshot.formatContext.app)
          }
        : undefined;
    })
    .filter((entry) => entry !== undefined)
    .reverse();

  if (entries.length === 0) return { text: "" };

  const header = [
    "Live Discord channel transcript snapshot (fetched at turn time; may be incomplete):",
    "all timestamps are ISO 8601 UTC",
    "messages are ordered oldest to newest",
    "Sturm assistant responses are marker-only entries; their content is represented in persisted assistant history",
    "Sturm markers correspond chronologically to prior assistant responses in persisted assistant history",
    "the current Discord user message appears after this snapshot as the final user message in the model input"
  ].join("\n");
  const transcriptHeader = "Recent messages:";
  let keptEntries = entries;
  while (
    [header, transcriptHeader, ...keptEntries.map((entry) => entry.text)].join(
      "\n"
    ).length > LIVE_CHANNEL_SNAPSHOT_MAX_CHARS &&
    keptEntries.length > 1
  ) {
    keptEntries = keptEntries.slice(1);
  }

  const block = [
    header,
    transcriptHeader,
    ...keptEntries.map((entry) => entry.text)
  ].join("\n");
  return {
    text: limitText(block, LIVE_CHANNEL_SNAPSHOT_MAX_CHARS),
    oldestVisibleMessageId: keptEntries[0]?.id,
    newestVisibleNonSturmMessageId: findNewestNonSturmMessageId(keptEntries)
  };
}

function findNewestNonSturmMessageId(
  entries: { id: string; isSturm: boolean }[]
) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry && !entry.isSturm) return entry.id;
  }
  return undefined;
}

function limitText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
