import type {
  ExecutionState,
  PendingAction,
  ToolLogEntry
} from "@cloudflare/codemode";

const DEFAULT_INSPECTION_LIMIT = 10;
const MAX_INSPECTION_LIMIT = 50;
const DEFAULT_PREVIEW_MAX_CHARS = 1200;
const MAX_PREVIEW_MAX_CHARS = 4000;
const MAX_EXECUTION_LOG_LINES = 20;

export type CodeModeInspectionRequest = {
  limit?: number;
  executionId?: string;
  previewMaxChars?: number;
};

export type NormalizedCodeModeInspectionRequest = {
  limit: number;
  executionId?: string;
  previewMaxChars: number;
};

export type CodeModeInspectionInput = {
  executions: ExecutionState[];
  pendingActions: PendingAction[];
  request: NormalizedCodeModeInspectionRequest;
  inspectedAt: string;
};

export function normalizeCodeModeInspectionRequest(
  request: CodeModeInspectionRequest = {}
): NormalizedCodeModeInspectionRequest {
  return {
    limit: clampInteger(
      request.limit,
      DEFAULT_INSPECTION_LIMIT,
      1,
      MAX_INSPECTION_LIMIT
    ),
    executionId: request.executionId?.trim() || undefined,
    previewMaxChars: clampInteger(
      request.previewMaxChars,
      DEFAULT_PREVIEW_MAX_CHARS,
      100,
      MAX_PREVIEW_MAX_CHARS
    )
  };
}

export function createCodeModeInspection(input: CodeModeInspectionInput) {
  const { request } = input;
  const executions = request.executionId
    ? input.executions.filter(
        (execution) => execution.id === request.executionId
      )
    : input.executions.slice(0, request.limit);
  const nonTerminalExecutions = input.executions.filter(
    (execution) => !isTerminalExecutionStatus(execution.status)
  );

  return {
    source: "codemode_runtime",
    inspectedAt: input.inspectedAt,
    payloadMode: "preview",
    query: {
      limit: request.limit,
      executionId: request.executionId,
      previewMaxChars: request.previewMaxChars
    },
    executionCount: executions.length,
    totalInspectedExecutionCount: input.executions.length,
    requestedExecutionFound: request.executionId
      ? executions.length > 0
      : undefined,
    nonTerminalExecutionCount: nonTerminalExecutions.length,
    pendingActionCount: input.pendingActions.length,
    pendingActions: input.pendingActions.map((action) =>
      createPendingActionInspection(action, request.previewMaxChars)
    ),
    executions: executions.map((execution) =>
      createExecutionInspection(
        execution,
        input.inspectedAt,
        request.previewMaxChars
      )
    )
  };
}

function createExecutionInspection(
  execution: ExecutionState,
  inspectedAt: string,
  previewMaxChars: number
) {
  const createdAt = toIsoTimestamp(execution.createdAt);
  const updatedAt = toIsoTimestamp(execution.updatedAt);
  const inspectedAtMs = Date.parse(inspectedAt);
  const ageMs = Number.isFinite(inspectedAtMs)
    ? Math.max(0, inspectedAtMs - execution.updatedAt)
    : undefined;

  return {
    executionId: execution.id,
    status: execution.status,
    terminal: isTerminalExecutionStatus(execution.status),
    createdAt,
    updatedAt,
    durationMs: Math.max(0, execution.updatedAt - execution.createdAt),
    ageMs,
    connectors: execution.connectors ?? [],
    code: createTextPreview(execution.code, previewMaxChars),
    toolCallCount: execution.log.length,
    toolCalls: execution.log.map((entry) =>
      createToolLogEntryInspection(entry, previewMaxChars)
    ),
    result: createValuePreview(execution.result, previewMaxChars),
    error: execution.error,
    logs: createExecutionLogsInspection(execution.logs, previewMaxChars)
  };
}

function createToolLogEntryInspection(
  entry: ToolLogEntry,
  previewMaxChars: number
) {
  return {
    seq: entry.seq,
    connector: entry.connector,
    method: entry.method,
    state: entry.state,
    requiresApproval: entry.requiresApproval,
    ephemeral: entry.ephemeral === true ? true : undefined,
    args: createValuePreview(entry.args, previewMaxChars),
    result: createValuePreview(entry.result, previewMaxChars)
  };
}

function createPendingActionInspection(
  action: PendingAction,
  previewMaxChars: number
) {
  return {
    executionId: action.executionId,
    seq: action.seq,
    connector: action.connector,
    method: action.method,
    args: createValuePreview(action.args, previewMaxChars)
  };
}

function createExecutionLogsInspection(
  logs: string[] | undefined,
  previewMaxChars: number
) {
  if (!logs) return undefined;
  const entries = logs
    .slice(-MAX_EXECUTION_LOG_LINES)
    .map((line) => createTextPreview(line, previewMaxChars));
  return {
    count: logs.length,
    omitted: Math.max(0, logs.length - entries.length),
    entries
  };
}

function createValuePreview(value: unknown, maxChars: number) {
  if (value === undefined) return undefined;
  const type = getValueType(value);
  const serialized = serializeValue(value);
  return {
    type,
    serializedLength: serialized.length,
    ...createTextPreview(serialized, maxChars)
  };
}

function createTextPreview(text: string, maxChars: number) {
  return {
    preview: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
    length: text.length
  };
}

function serializeValue(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, createJsonReplacer()) ?? String(value);
  } catch {
    return String(value);
  }
}

function createJsonReplacer() {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value;
  };
}

function getValueType(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isTerminalExecutionStatus(status: ExecutionState["status"]) {
  return (
    status === "completed" ||
    status === "error" ||
    status === "rejected" ||
    status === "rolled_back"
  );
}

function toIsoTimestamp(epochMs: number) {
  const date = new Date(epochMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
) {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
