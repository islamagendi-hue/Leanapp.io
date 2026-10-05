/**
 * Structured logging: one JSON object per line, so Vercel / any log drain can
 * filter by level, event and request id. Errors are flattened to name, message
 * and stack. Never pass secrets, tokens or end-user properties as fields.
 */
type Level = "info" | "warn" | "error";
type Fields = Record<string, unknown>;

function serialize(v: unknown): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack?.split("\n").slice(0, 8).join("\n"), code: (v as { code?: unknown }).code };
  return v;
}

/** The request id set by the proxy, when called inside a request. */
async function requestId(): Promise<string | undefined> {
  try {
    const { headers } = await import("next/headers");
    return (await headers()).get("x-request-id") ?? undefined;
  } catch {
    return undefined; // outside a request (tests, after() callbacks, scripts)
  }
}

export function write(level: Level, event: string, fields: Fields = {}, reqId?: string): void {
  const entry: Fields = { level, event, time: new Date().toISOString() };
  if (reqId) entry.request_id = reqId;
  for (const [k, v] of Object.entries(fields)) entry[k] = serialize(v);
  const line = JSON.stringify(entry);
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

async function emit(level: Level, event: string, fields?: Fields) {
  write(level, event, fields, (fields?.request_id as string | undefined) ?? (await requestId()));
}

export const log = {
  info: (event: string, fields?: Fields) => void emit("info", event, fields),
  warn: (event: string, fields?: Fields) => void emit("warn", event, fields),
  error: (event: string, fields?: Fields) => void emit("error", event, fields),
};
