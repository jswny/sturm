import type { GuildMemoryCatalog, GuildMemoryRecord } from "./memory";

export function formatGuildMemoryContext(records: GuildMemoryRecord[]) {
  const sections = [
    formatRecordGroup(
      "Guild facts",
      records.filter((record) => record.kind === "guild")
    ),
    formatRecordGroup(
      "User facts",
      records.filter((record) => record.kind === "user")
    ),
    formatRecordGroup(
      "Relationship facts",
      records.filter((record) => record.kind === "relationship")
    ),
    formatRecordGroup(
      "Legacy memory",
      records.filter((record) => record.kind === "legacy")
    )
  ].filter(Boolean);

  return sections.join("\n\n");
}

export function formatGuildMemoryReflectionContext(
  catalog: GuildMemoryCatalog
) {
  if (catalog.records.length === 0) {
    return [
      `catalogVersion: ${catalog.version}`,
      `catalogEpoch: ${catalog.epoch}`,
      "records: []"
    ].join("\n");
  }

  return [
    `catalogVersion: ${catalog.version}`,
    `catalogEpoch: ${catalog.epoch}`,
    "records:",
    ...catalog.records.map((record) =>
      JSON.stringify({
        memoryId: record.memoryId,
        kind: record.kind,
        subjectUserIds: record.subjectUserIds,
        assertedByUserId: record.assertedByUserId,
        content: record.content
      })
    )
  ].join("\n");
}

function formatRecordGroup(title: string, records: GuildMemoryRecord[]) {
  if (records.length === 0) return "";
  return [title, ...records.map((record) => `- ${formatRecord(record)}`)].join(
    "\n"
  );
}

function formatRecord(record: GuildMemoryRecord) {
  const provenance = record.assertedByUserId
    ? ` (assertedByDiscordUserId: ${record.assertedByUserId})`
    : "";

  if (record.kind === "user") {
    return `discordUserId ${record.subjectUserIds[0]}: ${record.content}${provenance}`;
  }

  if (record.kind === "relationship") {
    return `discordUserIds ${record.subjectUserIds.join(", ")}: ${record.content}${provenance}`;
  }

  if (record.kind === "guild") {
    return `${record.content}${provenance}`;
  }

  return record.content;
}
