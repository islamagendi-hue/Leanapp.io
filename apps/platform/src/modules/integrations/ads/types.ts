import type { AdProvider } from "../registry";
import type { HttpOptions } from "./http";

/**
 * The shared interface every ad-provider adapter implements (inbound
 * reporting only; outbound conversions live in modules/attribution). The sync
 * engine (../sync.ts) drives it: prepare (token refresh) → listAccounts
 * (verification) → report pages for each chosen account and day range.
 */
export type Secrets = Record<string, string>;
export type Settings = Record<string, string>;

export interface FieldSpec {
  key: string;
  label: string;
  required: boolean;
  /** Help text (msg-marked). */
  help?: string;
  pattern?: RegExp;
}

export interface AdAccount {
  id: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
}

/** One provider row: one day for one ad (or campaign, when the provider reports at that level). */
export interface AdDailyRow {
  day: string; // YYYY-MM-DD in the ad account's timezone
  accountId: string;
  currency: string;
  campaignId: string;
  campaignName: string | null;
  adsetId: string; // '' when not reported at this level
  adsetName: string | null;
  adId: string; // '' when not reported at this level
  adName: string | null;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number | null;
}

export interface Session {
  accessToken: string;
  /** Credentials changed during prepare (e.g. a rotated refresh token): the engine re-encrypts and stores them. */
  updatedSecrets?: Secrets;
  /** When the access token expires, if the provider said. */
  expiresAt?: Date | null;
  /** Other per-run values an adapter needs on each call (e.g. Google's developer token). Never logged. */
  extra?: Record<string, string>;
}

export interface ReportPage {
  rows: AdDailyRow[];
  /** Opaque cursor for the next page; absent on the last page. */
  next?: string;
}

export interface AdAdapter {
  provider: AdProvider;
  /** Label used as the Ad spend `source` unless the connection overrides it. */
  defaultSpendSource: string;
  /** Secret fields (encrypted), non-secret settings (config). */
  secrets: FieldSpec[];
  settings: FieldSpec[];
  /** Missing required fields, as labels; empty when complete. */
  missing(secrets: Secrets, settings: Settings): string[];
  /** Token refresh hook: returns an access token, refreshing when the provider needs it. */
  prepare(secrets: Secrets, settings: Settings, http: HttpOptions): Promise<Session>;
  /** Ad accounts the credentials can read (used to verify a connection). */
  listAccounts(session: Session, settings: Settings, http: HttpOptions): Promise<AdAccount[]>;
  /** One page of daily rows for an account over [from, to] (inclusive). */
  report(session: Session, settings: Settings, q: { account: AdAccount; from: string; to: string; cursor?: string }, http: HttpOptions): Promise<ReportPage>;
}

export function missingFields(specs: FieldSpec[], values: Record<string, string>): string[] {
  return specs.filter((f) => f.required && !values[f.key]?.trim()).map((f) => f.label);
}

export const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
