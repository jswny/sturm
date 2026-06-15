export async function pruneDurableStorageRecords<T>(
  storage: DurableObjectStorage,
  options: {
    prefix: string;
    limit?: number;
    shouldPrune(record: T, key: string): boolean;
  }
) {
  const records = await storage.list<T>(
    options.limit === undefined
      ? { prefix: options.prefix }
      : { prefix: options.prefix, limit: options.limit }
  );
  const keysToDelete: string[] = [];

  for (const [key, record] of records) {
    if (options.shouldPrune(record, key)) keysToDelete.push(key);
  }

  if (keysToDelete.length > 0) {
    await storage.delete(keysToDelete);
  }

  return keysToDelete.length;
}

export function isTimestampBefore(value: string, cutoffMs: number) {
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) && timestampMs < cutoffMs;
}
