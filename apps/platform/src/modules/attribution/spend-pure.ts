import { msg } from "@/i18n/translate";
import { NON_SPEND_SOURCES } from "@/modules/channels/registry";

/**
 * Ad spend entered by hand or by CSV (see ./spend.ts): validation, CSV
 * parsing and the two return figures the Revenue report shows next to it.
 * Pure, so it is unit-tested without a database.
 */

export interface SpendInput {
  /** Calendar day in the app's timezone, YYYY-MM-DD. */
  date: string;
  /** Attribution source, as Acquisition shows it (tiktok, meta, google…). */
  source: string;
  /** '' when the spend is not for one campaign. */
  campaign: string;
  /** ISO 4217, upper case. */
  currency: string;
  amount: number;
}

export const MAX_SPEND_AMOUNT = 999_999_999_999.99;
export const MAX_CSV_ROWS = 5000;
export const CSV_COLUMNS = ["date", "source", "campaign", "currency", "amount"] as const;

/** Channels with no paid source behind them (organic, direct, unknown, unattributed): spend can't be put on these. */
const RESERVED_SOURCES = NON_SPEND_SOURCES;

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Checks one entry. `today` is today's date in the app's timezone: spend
 * can't be entered for a day that hasn't started. Returns the clean entry or
 * the message (marked with msg()) of the first problem.
 */
export function validateSpend(
  raw: { date?: unknown; source?: unknown; campaign?: unknown; currency?: unknown; amount?: unknown },
  today: string,
): { ok: true; value: SpendInput } | { ok: false; field: keyof SpendInput; error: string } {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  const date = str(raw.date);
  if (!validDate(date)) return { ok: false, field: "date", error: msg("Enter the date as YYYY-MM-DD.") };
  if (date < "2000-01-01" || date > today) return { ok: false, field: "date", error: msg("The date can't be in the future.") };
  const source = str(raw.source);
  if (!source || source.length > 100) return { ok: false, field: "source", error: msg("Enter the source (1–100 characters), as Acquisition shows it.") };
  if (RESERVED_SOURCES.has(source.toLowerCase())) return { ok: false, field: "source", error: msg("Spend can't be put on organic, direct, unknown or unattributed installs.") };
  const campaign = str(raw.campaign);
  if (campaign.length > 100) return { ok: false, field: "campaign", error: msg("The campaign is at most 100 characters.") };
  const currency = str(raw.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, field: "currency", error: msg("Use a 3-letter currency code.") };
  const text = str(raw.amount).replace(/[\s,]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text) || Number(text) > MAX_SPEND_AMOUNT) {
    return { ok: false, field: "amount", error: msg("Enter the amount as a number of 0 or more, with at most 2 decimals.") };
  }
  return { ok: true, value: { date, source, campaign, currency, amount: Number(text) } };
}

/** Splits one CSV line into fields (commas, double-quoted fields with "" escapes). */
function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

export interface CsvRowError {
  /** 1-based line number in the pasted text or file. */
  line: number;
  /** Marked with msg(). */
  error: string;
}

/**
 * Parses spend CSV with the columns date,source,campaign,currency,amount (a
 * header row with those names is optional and skipped). Blank lines are
 * ignored. A later row for the same day, source, campaign and currency
 * replaces an earlier one, as saving it again would.
 */
export function parseSpendCsv(text: string, today: string): { rows: SpendInput[]; errors: CsvRowError[] } {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  const rows = new Map<string, SpendInput>();
  const errors: CsvRowError[] = [];
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const f = csvFields(lines[i]);
    if (seen === 0 && f[0]?.toLowerCase() === "date" && f.map((x) => x.toLowerCase()).join(",") === CSV_COLUMNS.join(",")) continue;
    seen++;
    if (seen > MAX_CSV_ROWS) {
      errors.push({ line: i + 1, error: msg("Import at most 5,000 rows at a time.") });
      break;
    }
    if (f.length !== CSV_COLUMNS.length) {
      errors.push({ line: i + 1, error: msg("Each row needs 5 columns: date, source, campaign, currency, amount.") });
      continue;
    }
    const r = validateSpend({ date: f[0], source: f[1], campaign: f[2], currency: f[3], amount: f[4] }, today);
    if (!r.ok) errors.push({ line: i + 1, error: r.error });
    else rows.set(spendKey(r.value), r.value);
  }
  if (seen === 0 && errors.length === 0) errors.push({ line: 1, error: msg("Paste or upload at least one row.") });
  return { rows: [...rows.values()], errors };
}

export const spendKey = (s: Pick<SpendInput, "date" | "source" | "campaign" | "currency">) => [s.date, s.source, s.campaign, s.currency].join("\u0000");

/** Gross revenue minus spend, in the same currency (negative when spend is higher). Null without spend. */
export function grossReturn(gross: number, spend: number | null | undefined): number | null {
  if (spend === null || spend === undefined) return null;
  return Math.round((gross - spend) * 100) / 100;
}

/** ROAS: gross revenue divided by spend, in the same currency. Null without spend (or spend of 0). */
export function roas(gross: number, spend: number | null | undefined): number | null {
  if (!spend) return null;
  return Math.round((gross / spend) * 100) / 100;
}
