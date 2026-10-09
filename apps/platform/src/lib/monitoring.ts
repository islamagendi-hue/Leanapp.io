/**
 * Error tracking and alerts without a vendor SDK (docs/ops/monitoring.md).
 *
 * Reports go to whichever destinations are configured, both optional:
 *   ALERT_WEBHOOK_URL  Slack- or Discord-compatible incoming webhook (JSON `text` + `content`)
 *   SENTRY_DSN         a Sentry project, via its plain HTTP envelope endpoint
 * With neither set, reports are only written to the server log (`monitoring.report`).
 *
 * What a report may carry: source, route template (never the concrete URL),
 * error name and scrubbed message, digest, environment, commit, and small
 * numeric/string details chosen by the caller. Never: headers, cookies, request
 * or event bodies, tokens, keys or personal data. Every string passes `scrub`.
 *
 * Throttling is per server instance (in memory): one report per key per window,
 * and at most MAX_PER_WINDOW reports per window in total; suppressed repeats
 * are counted and mentioned in the next report for that key. Delivery never
 * throws and is time-boxed, so monitoring can't take a request down with it.
 *
 * No `server-only` import: instrumentation.ts loads this module in every runtime.
 */
import { write } from "@/lib/log";

export const THROTTLE_WINDOW_MS = 10 * 60_000;
export const MAX_PER_WINDOW = 10;
const DELIVERY_TIMEOUT_MS = 3_000;
const MESSAGE_MAX = 300;

type Detail = string | number | boolean | null | undefined;

export interface Report {
  /** Dedupe key: reports with the same key are throttled together. */
  key: string;
  severity: "error" | "warning";
  /** One line, e.g. "Exception in GET /v1/events". Scrubbed. */
  title: string;
  /** Where it came from: "request", "worker", "ingestion", "worker-health", ... */
  source: string;
  route?: string;
  error?: { name: string; message: string; digest?: string };
  details?: Record<string, Detail>;
}

// ── Scrubbing ────────────────────────────────────────────────────────────────

const SCRUB_RULES: [RegExp, string][] = [
  // Credentials inside URLs (postgres://user:pass@host, https://token@host).
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@"],
  // Query strings carry tokens and personal data; keep the path only.
  [/\b(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1?[redacted]"],
  [/\bBearer\s+[^\s"',;]+/gi, "Bearer [redacted]"],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, "Basic [redacted]"],
  // LeanApp keys, Stripe / Resend keys and webhook secrets, JWTs.
  [/\bla_(sk|pk)_[A-Za-z0-9_-]+/g, "la_$1_[redacted]"],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]+/g, "$1_$2_[redacted]"],
  [/\bwhsec_[A-Za-z0-9+/=]+/g, "whsec_[redacted]"],
  [/\bre_[A-Za-z0-9_]{16,}/g, "re_[redacted]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[jwt]"],
  // key=value / "key": "value" pairs whose name says they are secret.
  [
    /\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|cookie|set-cookie|session|signature|access[_-]?token|refresh[_-]?token|private[_-]?key|dsn)(["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi,
    "$1$2[redacted]",
  ],
  // Personal data: emails, IPv4 addresses, phone-like numbers.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[ip]"],
  [/\+\d[\d -]{7,}\d/g, "[phone]"],
  // Long opaque strings (tokens, hashes, ids incl. UUIDs).
  [/\b[A-Za-z0-9_-]{32,}={0,2}/g, "[redacted]"],
];

/** Removes secrets and personal data from free text and caps its length. */
export function scrub(text: string, max = MESSAGE_MAX): string {
  let out = text;
  for (const [re, to] of SCRUB_RULES) out = out.replace(re, to);
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/**
 * A route for a report: the query string is dropped and dynamic-looking
 * segments (numbers, UUIDs, tokens, emails) become `:id`. Prefer the route
 * template (Next's `routePath`) when there is one.
 */
export function scrubRoute(path: string): string {
  const bare = path.split(/[?#]/)[0] || "/";
  return bare
    .split("/")
    .map((seg) => (/^\d+$|^[0-9a-f-]{16,}$|^[A-Za-z0-9_-]{24,}$|@|^la_/i.test(seg) ? ":id" : seg))
    .join("/")
    .slice(0, 200);
}

function scrubDetails(details: Record<string, Detail> | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(details ?? {})) {
    if (v === undefined) continue;
    out[k.slice(0, 40)] = typeof v === "string" ? scrub(v, 200) : v;
  }
  return out;
}

// ── Throttling ───────────────────────────────────────────────────────────────

const recent = new Map<string, { until: number; suppressed: number }>();
let windowStart = 0;
let sentInWindow = 0;

/** Decides whether a report with `key` goes out now; returns how many were suppressed before it. */
export function admit(key: string, now = Date.now()): { send: boolean; suppressed: number } {
  if (recent.size > 500) for (const [k, v] of recent) if (v.until <= now) recent.delete(k);
  const entry = recent.get(key);
  if (entry && entry.until > now) {
    entry.suppressed++;
    return { send: false, suppressed: entry.suppressed };
  }
  if (now - windowStart >= THROTTLE_WINDOW_MS) {
    windowStart = now;
    sentInWindow = 0;
  }
  const suppressed = entry?.suppressed ?? 0;
  if (sentInWindow >= MAX_PER_WINDOW) {
    // Global cap reached: remember the key so the next report says how many were dropped.
    recent.set(key, { until: windowStart + THROTTLE_WINDOW_MS, suppressed: suppressed + 1 });
    return { send: false, suppressed: suppressed + 1 };
  }
  sentInWindow++;
  recent.set(key, { until: now + THROTTLE_WINDOW_MS, suppressed: 0 });
  return { send: true, suppressed };
}

/** Test hook. */
export function resetMonitoring(): void {
  recent.clear();
  windowStart = 0;
  sentInWindow = 0;
}

// ── Context ──────────────────────────────────────────────────────────────────

export function environmentName(): string {
  return process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown";
}

export function commitSha(): string | null {
  return process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || null;
}

// ── Delivery ─────────────────────────────────────────────────────────────────

export function formatText(r: Report, suppressed: number): string {
  const lines = [`[LeanApp ${environmentName()}] ${r.severity === "error" ? "ERROR" : "WARNING"}: ${r.title}`];
  if (r.error) lines.push(`${r.error.name}: ${r.error.message}`);
  const meta: string[] = [`source: ${r.source}`];
  if (r.route) meta.push(`route: ${r.route}`);
  if (r.error?.digest) meta.push(`digest: ${r.error.digest}`);
  meta.push(`commit: ${commitSha() ?? "unknown"}`);
  lines.push(meta.join(" · "));
  const details = Object.entries(r.details ?? {}).map(([k, v]) => `${k}=${v}`);
  if (details.length) lines.push(details.join(" · "));
  if (suppressed) lines.push(`(${suppressed} similar report(s) suppressed since the last one)`);
  return lines.join("\n").slice(0, 1900); // Discord's limit is 2000 characters
}

async function post(destination: string, url: string, init: RequestInit): Promise<void> {
  try {
    const res = await fetch(url, { ...init, method: "POST", signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) write("error", "monitoring.delivery_failed", { destination, status: res.status });
  } catch (e) {
    // Never log the URL: webhook URLs and DSNs are credentials.
    write("error", "monitoring.delivery_failed", { destination, reason: e instanceof Error ? e.name : "unknown" });
  }
}

interface SentryTarget {
  endpoint: string;
  publicKey: string;
  dsn: string;
}

/** `https://<public key>@<host>[/<prefix>]/<project id>` → envelope endpoint; null when malformed. */
export function parseSentryDsn(dsn: string | undefined): SentryTarget | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const parts = u.pathname.split("/").filter(Boolean);
    const project = parts.pop();
    if (!u.username || !project || !/^\d+$/.test(project) || u.protocol !== "https:") return null;
    const prefix = parts.length ? `/${parts.join("/")}` : "";
    return { endpoint: `${u.protocol}//${u.host}${prefix}/api/${project}/envelope/`, publicKey: u.username, dsn };
  } catch {
    return null;
  }
}

function sentryEnvelope(r: Report, target: SentryTarget): string {
  const eventId = crypto.randomUUID().replace(/-/g, "");
  const event: Record<string, unknown> = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: "node",
    level: r.severity === "error" ? "error" : "warning",
    logger: r.source,
    environment: environmentName(),
    release: commitSha() ?? undefined,
    transaction: r.route,
    tags: { source: r.source, ...(r.route ? { route: r.route } : {}), ...(r.error?.digest ? { digest: r.error.digest } : {}) },
    extra: r.details ?? {},
    fingerprint: [r.key],
  };
  if (r.error) event.exception = { values: [{ type: r.error.name, value: r.error.message }] };
  else event.message = { formatted: r.title };
  const header = { event_id: eventId, sent_at: new Date().toISOString(), dsn: target.dsn };
  return `${JSON.stringify(header)}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
}

/**
 * Sends a report to the configured destinations, subject to throttling.
 * Always writes one compact log line. Never throws.
 */
export async function report(input: Report): Promise<void> {
  try {
    const r: Report = {
      ...input,
      key: input.key.slice(0, 200),
      title: scrub(input.title, 200),
      route: input.route ? scrubRoute(input.route) : undefined,
      error: input.error
        ? { name: scrub(input.error.name, 80), message: scrub(input.error.message), digest: input.error.digest ? scrub(input.error.digest, 64) : undefined }
        : undefined,
      details: scrubDetails(input.details),
    };
    const { send, suppressed } = admit(r.key);
    write(r.severity === "error" ? "error" : "warn", "monitoring.report", {
      key: r.key,
      title: r.title,
      source: r.source,
      route: r.route,
      error: r.error,
      details: r.details,
      environment: environmentName(),
      commit: commitSha(),
      delivered: send,
      suppressed,
    });
    if (!send) return;
    const deliveries: Promise<void>[] = [];
    const webhook = process.env.ALERT_WEBHOOK_URL?.trim();
    if (webhook) {
      const text = formatText(r, suppressed);
      // `text` is what Slack reads, `content` what Discord reads; each ignores the other.
      deliveries.push(post("webhook", webhook, { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, content: text }) }));
    }
    const sentry = parseSentryDsn(process.env.SENTRY_DSN?.trim());
    if (sentry) {
      deliveries.push(
        post("sentry", sentry.endpoint, {
          headers: {
            "Content-Type": "application/x-sentry-envelope",
            "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${sentry.publicKey}, sentry_client=leanapp-monitoring/1.0`,
          },
          body: sentryEnvelope(r, sentry),
        }),
      );
    }
    await Promise.all(deliveries);
  } catch {
    // Monitoring must never break the caller.
  }
}

/** Framework control-flow "errors" (notFound, redirect, dynamic bailout) are not failures. */
function isControlFlow(err: unknown): boolean {
  const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest) : "";
  return /^(NEXT_|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING)/.test(digest);
}

/** Expected client errors (AppError and subclasses with a 4xx status) are not reported. */
function isClientError(err: unknown): boolean {
  const status = typeof err === "object" && err !== null && "status" in err ? (err as { status: unknown }).status : undefined;
  return typeof status === "number" && status >= 400 && status < 500;
}

const captured = new WeakSet<object>();

/** Reports an unexpected server-side exception (once per error object). */
export async function captureException(
  err: unknown,
  ctx: { source: string; route?: string; title?: string; details?: Record<string, Detail> },
): Promise<void> {
  if (isControlFlow(err) || isClientError(err)) return;
  // A step that reported its error rethrows it; Next's onRequestError must not report it again.
  if (typeof err === "object" && err !== null) {
    if (captured.has(err)) return;
    captured.add(err);
  }
  const e = err instanceof Error ? err : null;
  const name = e?.name || typeof err;
  const message = e ? e.message : typeof err === "string" ? err : "Non-error value thrown";
  const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest) : undefined;
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : undefined;
  const route = ctx.route ? scrubRoute(ctx.route) : undefined;
  await report({
    key: `exception:${ctx.source}:${route ?? "-"}:${name}:${scrub(message, 80)}`,
    severity: "error",
    title: ctx.title ?? `Exception in ${route ?? ctx.source}`,
    source: ctx.source,
    route,
    error: { name, message, digest },
    details: { ...ctx.details, ...(code ? { code } : {}) },
  });
}

/** One server error response (5xx) at a route boundary, when no exception reached us. */
export function reportServerErrorResponse(route: string, status: number): Promise<void> {
  return report({
    key: `5xx:${route}`,
    severity: "error",
    title: `HTTP ${status} from ${route}`,
    source: "http",
    route,
    details: { status },
  });
}
