/**
 * HTTP for ad-provider adapters: JSON requests with a timeout, retries with
 * exponential backoff (honouring Retry-After) for rate limits and transient
 * failures, a per-run request budget and deadline, and errors classified so
 * the sync engine knows whether to retry, wait, or ask for new credentials.
 *
 * Error messages never contain URLs or headers (tokens travel in both).
 */
export type ProviderErrorKind = "auth" | "rate_limited" | "transient" | "permanent" | "config";

export class ProviderError extends Error {
  constructor(
    public kind: ProviderErrorKind,
    message: string,
    public status: number | null = null,
    public providerCode: string | null = null,
  ) {
    super(message.slice(0, 500));
    this.name = "ProviderError";
  }
}

export interface HttpOptions {
  fetchImpl?: typeof fetch;
  /** Total requests allowed for this run (shared across calls). */
  budget?: { remaining: number; used: number };
  /** Epoch ms after which no new request starts. */
  deadline?: number;
  maxAttempts?: number;
  /** Base backoff in ms (tests use 0). */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface JsonRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Hosts this request may go to; a URL taken from a response (paging) must match. */
  allowedHosts: string[];
}

/**
 * Maps a provider response to an error, or null when it is a success. Each
 * adapter supplies its own (e.g. Meta signals rate limits with HTTP 400 and
 * error code 17).
 */
export type Classifier = (status: number, body: unknown) => ProviderError | null;

export const defaultClassifier: Classifier = (status, body) => {
  if (status >= 200 && status < 300) return null;
  const detail = typeof body === "object" && body ? JSON.stringify(body).slice(0, 300) : String(body ?? "").slice(0, 300);
  if (status === 401 || status === 403) return new ProviderError("auth", `HTTP ${status}: ${detail}`, status);
  if (status === 429) return new ProviderError("rate_limited", `HTTP 429: ${detail}`, status);
  if (status === 408 || status === 425 || status >= 500) return new ProviderError("transient", `HTTP ${status}: ${detail}`, status);
  return new ProviderError("permanent", `HTTP ${status}: ${detail}`, status);
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function backoffMs(attempt: number, base: number, retryAfter: string | null): number {
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 60_000);
  return Math.min(base * 2 ** (attempt - 1), 30_000);
}

export async function requestJson<T>(req: JsonRequest, classify: Classifier, opts: HttpOptions = {}): Promise<T> {
  const host = new URL(req.url).host;
  if (new URL(req.url).protocol !== "https:" || !req.allowedHosts.includes(host)) {
    throw new ProviderError("permanent", `Refused a request to an unexpected host (${host}).`);
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxAttempts = opts.maxAttempts ?? 4;
  const base = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? realSleep;
  for (let attempt = 1; ; attempt++) {
    if (opts.deadline && Date.now() >= opts.deadline) throw new ProviderError("transient", "Stopped: the run's time budget ran out.");
    if (opts.budget) {
      if (opts.budget.remaining <= 0) throw new ProviderError("rate_limited", "Stopped: the run's request budget ran out.");
      opts.budget.remaining--;
      opts.budget.used++;
    }
    let status = 0;
    let body: unknown = null;
    let retryAfter: string | null = null;
    let err: ProviderError | null;
    try {
      const res = await fetchImpl(req.url, {
        method: req.method ?? "GET",
        headers: { Accept: "application/json", "User-Agent": "LeanApp-Integrations/1.0", ...req.headers },
        body: req.body,
        redirect: "error",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
      status = res.status;
      retryAfter = res.headers.get("retry-after");
      const text = await res.text();
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text.slice(0, 300);
      }
      err = classify(status, body);
    } catch (e) {
      const x = e as Error;
      err = new ProviderError("transient", x.name === "TimeoutError" ? "The provider did not answer in time." : `Network error: ${x.message}`.slice(0, 200));
    }
    if (!err) return body as T;
    const retry = err.kind === "rate_limited" || err.kind === "transient";
    if (!retry || attempt >= maxAttempts) throw err;
    await sleep(backoffMs(attempt, base, retryAfter));
  }
}

/** Query string from params; arrays and objects are JSON-encoded (TikTok style). */
export function qs(params: Record<string, string | number | undefined | null | object>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    u.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return u.toString();
}
