export type LogContext = Record<string, unknown>;
type LogLevel = "info" | "warn" | "error";

export function logInfo(message: string, context?: LogContext) {
  log("info", message, context);
}

export function logWarn(message: string, context?: LogContext) {
  log("warn", message, context);
}

export function logError(
  message: string,
  error?: unknown,
  context?: LogContext
) {
  log("error", message, {
    ...context,
    error: serializeError(error)
  });
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function log(level: LogLevel, message: string, context?: LogContext) {
  const details = removeUndefined(context);
  console[level]({
    ...details,
    level,
    message
  });
}

function serializeError(error: unknown) {
  if (!error) return undefined;

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return String(error);
}

function removeUndefined(context: LogContext | undefined) {
  if (!context) return {};

  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined)
  );
}
