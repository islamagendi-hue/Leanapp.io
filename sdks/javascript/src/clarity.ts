/**
 * Microsoft Clarity identity bridge (browsers only, opt-in). When the page
 * already has Clarity's tag (window.clarity), tells Clarity who this visitor
 * is in LeanApp, so a recording can be found from a LeanApp user profile:
 *
 *   clarity("identify", <LeanApp user id, else anonymous id>)
 *   clarity("set", "leanapp_anonymous_id", <anonymous id>)
 *
 * Only with analytics consent granted. The SDK never loads, configures or
 * gives consent to Clarity itself: the site installs Clarity's tag and, in
 * the EEA, UK and Switzerland, sends Clarity its own consent signal
 * (Clarity Consent API). See docs/clarity-integration.md.
 */
import type { ConsentStatus, Platform } from "./client.js";

export interface ClarityOptions {
  /** Turn the bridge on. Default false. */
  enabled?: boolean;
}

/** The Clarity custom tag that carries the LeanApp anonymous id. */
export const CLARITY_ANONYMOUS_TAG = "leanapp_anonymous_id";

type ClarityFn = (...args: unknown[]) => unknown;

/** window.clarity when the page has Clarity's tag (or its queueing stub), else null. */
export function clarityFunction(g: unknown = globalThis): ClarityFn | null {
  const c = (g as { clarity?: unknown } | undefined)?.clarity;
  return typeof c === "function" ? (c as ClarityFn) : null;
}

export interface ClarityIdentity {
  platform: Platform;
  analytics: ConsentStatus;
  anonymousId: string;
  userId?: string | null;
}

export class ClarityBridge {
  /** The identity last sent, so repeated calls are free; null until sent (or after consent was withdrawn). */
  private sent: string | null = null;

  constructor(
    private readonly enabled: boolean,
    private readonly lookup: () => ClarityFn | null = () => clarityFunction(),
  ) {}

  /**
   * Sends the identity to Clarity when allowed and changed. Returns true when it called Clarity.
   * Never throws: a broken Clarity tag must not break the app.
   */
  sync(id: ClarityIdentity): boolean {
    if (!this.enabled || id.platform !== "web") return false;
    if (id.analytics !== "granted") {
      // Granted again later: send again.
      this.sent = null;
      return false;
    }
    if (!id.anonymousId) return false;
    const key = `${id.userId ?? ""}\n${id.anonymousId}`;
    if (key === this.sent) return false;
    const clarity = this.lookup();
    if (!clarity) return false; // the tag isn't on the page (yet): the next call tries again
    try {
      clarity("identify", id.userId || id.anonymousId);
      clarity("set", CLARITY_ANONYMOUS_TAG, id.anonymousId);
    } catch {
      return false;
    }
    this.sent = key;
    return true;
  }
}
