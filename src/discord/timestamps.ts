export function formatUtcTimestampField(fieldName: string, timestamp: string) {
  return `${fieldName}: ${normalizeUtcTimestamp(timestamp)}`;
}

export function normalizeUtcTimestamp(timestamp: string) {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return timestamp;

  return new Date(parsed).toISOString();
}
