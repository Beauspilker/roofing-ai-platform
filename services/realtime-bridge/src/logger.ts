type LogFields = Record<string, string | number | boolean | null | undefined>;

function sanitizeFields(fields: LogFields): LogFields {
  const sanitized: LogFields = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }

    if (key.toLowerCase().includes("token") || key.toLowerCase().includes("secret")) {
      sanitized[key] = "[redacted]";
      continue;
    }

    if (key === "callSid" && typeof value === "string" && value.length > 8) {
      sanitized[key] = `${value.slice(0, 4)}...${value.slice(-4)}`;
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

export function logInfo(event: string, fields: LogFields = {}): void {
  console.info(JSON.stringify({ level: "info", event, ...sanitizeFields(fields) }));
}

export function logWarn(event: string, fields: LogFields = {}): void {
  console.warn(JSON.stringify({ level: "warn", event, ...sanitizeFields(fields) }));
}

export function logError(event: string, fields: LogFields = {}, error?: unknown): void {
  const message =
    error instanceof Error ? error.message : error ? String(error) : undefined;

  console.error(
    JSON.stringify({
      level: "error",
      event,
      ...sanitizeFields(fields),
      ...(message ? { errorMessage: message } : {}),
    }),
  );
}
