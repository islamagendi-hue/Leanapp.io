"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLang, useT } from "@/i18n/client";
import { dateLocale, msg, type Lang, type T } from "@/i18n/translate";
import type { ConnectionHealth, DebugEvent } from "@/modules/debugger/service";
import { localizeText } from "@/modules/implementation/localize";

const POLL_MS = 2000;
const MAX_EVENTS = 300;

/** Live event feed for one environment. Polls the debugger API; newest first. */
export function EventDebugger({ feedUrl, testCurl }: { feedUrl: string; testCurl: string }) {
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [health, setHealth] = useState<ConnectionHealth | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const lastId = useRef<string | null>(null);
  const t = useT();
  const lang = useLang();

  const poll = useCallback(async () => {
    try {
      const url = lastId.current ? `${feedUrl}?after=${lastId.current}` : feedUrl;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 401 ? msg("Your session expired. Sign in again.") : `Feed returned ${res.status}`);
      const data = (await res.json()) as { events: DebugEvent[]; health: ConnectionHealth };
      setHealth(data.health);
      setError(null);
      if (data.events.length) {
        lastId.current = data.events[0].id;
        setEvents((prev) => [...data.events, ...prev].slice(0, MAX_EVENTS));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : msg("Feed unavailable"));
    }
  }, [feedUrl]);

  useEffect(() => {
    if (paused) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await poll();
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [poll, paused]);

  const shown = filter ? events.filter((e) => e.event_name.includes(filter) || e.user_id?.includes(filter) || e.anonymous_id?.includes(filter)) : events;
  const current = events.find((e) => e.id === selected) ?? null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label={t("Status")} value={health ? (health.connected ? t("Connected") : t("Waiting for first event")) : "…"} accent={health?.connected} />
        <Stat label={t("Last event")} value={health?.lastEventAt ? new Date(health.lastEventAt).toLocaleTimeString(dateLocale(lang)) : "–"} />
        <Stat label={t("Events today")} value={String(health?.eventsToday ?? "–")} />
        <Stat label={t("Active users today")} value={String(health?.activeUsersToday ?? "–")} />
        <Stat
          label={t("Rejected today")}
          value={String(health?.rejectedToday ?? "–")}
          warn={!!health && health.rejectedToday > health.consentDeniedToday}
          hint={health?.consentDeniedToday ? t("{n} consent_denied (user denied analytics; expected)", { n: health.consentDeniedToday }) : undefined}
        />
      </div>

      {health && !health.connected && (
        <div className="card text-sm">
          <p className="font-medium">{t("No events yet in this environment.")}</p>
          <p className="mt-1 text-ink-2">{t("Send a test event from your terminal. It shows up here within a couple of seconds.")}</p>
          <pre className="code mt-3 overflow-x-auto whitespace-pre text-xs" dir="ltr">{testCurl}</pre>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <span className={`inline-flex items-center gap-2 text-sm ${paused ? "text-ink-3" : "text-accent-ink"}`}>
          <span className={`size-2 rounded-full ${paused ? "bg-ink-3" : "animate-pulse bg-accent"}`} />
          {paused ? t("Paused") : t("Live")}
        </span>
        <button type="button" className="btn-secondary" onClick={() => setPaused((p) => !p)}>{paused ? t("Resume") : t("Pause")}</button>
        <button type="button" className="btn-secondary" onClick={() => { setEvents([]); setSelected(null); }}>{t("Clear view")}</button>
        <input className="input max-w-xs" placeholder={t("Filter by event or user id")} value={filter} onChange={(e) => setFilter(e.target.value)} />
        {error && <span className="text-sm text-alert" role="alert">{error.startsWith("Feed returned ") ? t("Feed returned {status}", { status: error.slice(14) }) : t(error)}</span>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
        <div className="card max-h-[70vh] overflow-auto p-0">
          <table className="table">
            <thead className="sticky top-0 z-[1] bg-card"><tr><th>{t("Received")}</th><th>{t("Event")}</th><th>{t("User")}</th><th>{t("Platform")}</th><th>{t("Check")}</th></tr></thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-ink-3">{t("Listening for events…")}</td></tr>}
              {shown.map((e) => (
                <tr key={e.id} onClick={() => setSelected(e.id)} className={`cursor-pointer hover:bg-paper-2 ${selected === e.id ? "bg-accent-soft" : ""}`}>
                  <td className="whitespace-nowrap font-mono text-xs text-ink-3">{new Date(e.received_at).toLocaleTimeString(dateLocale(lang))}</td>
                  <td>
                    <span className="font-mono text-sm">{e.event_name}</span>
                    {e.canonical_name && <span className="ms-1 font-mono text-xs text-ink-3"><span aria-hidden className="inline-block rtl:-scale-x-100">→</span> {e.canonical_name}</span>}
                    {e.type !== "track" && <span className="pill ms-2 border-line text-ink-3">{e.type}</span>}
                  </td>
                  <td className="max-w-[160px] truncate font-mono text-xs">{e.user_id ?? <span className="text-ink-3">{t("anon {id}", { id: e.anonymous_id?.slice(0, 8) ?? "" })}</span>}</td>
                  <td className="text-xs text-ink-2">{e.platform ?? e.source}</td>
                  <td><Badge e={e} t={t} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card min-w-0 lg:sticky lg:top-24 lg:max-h-[calc(100dvh-7rem)] lg:self-start lg:overflow-y-auto">
          {current ? <EventDetail e={current} t={t} lang={lang} /> : <p className="text-sm text-ink-3">{t("Click an event to inspect its payload and validation.")}</p>}
        </div>
      </div>

      {health && health.connected && (
        <div className="grid gap-4 md:grid-cols-3">
          <Breakdown title={t("SDK versions (7 days)")} rows={health.sdkVersions.map((r) => [r.sdk, r.events])} />
          <Breakdown title={t("Platforms (7 days)")} rows={health.platforms.map((r) => [r.platform, r.events])} />
          <Breakdown title={t("App versions (7 days)")} rows={health.appVersions.map((r) => [r.app_version, r.events])} />
        </div>
      )}
    </div>
  );
}

function Badge({ e, t }: { e: DebugEvent; t: T }) {
  const v = e.validation;
  if (!v) return <span className="text-xs text-ink-3">{t("no plan")}</span>;
  if (!v.valid) return <span className="pill border-alert/50 text-alert">{v.errors.length > 1 ? t("{n} errors", { n: v.errors.length }) : t("{n} error", { n: v.errors.length })}</span>;
  if (!v.planned) return <span className="pill border-warn/50 text-warn">{t("unplanned")}</span>;
  if (v.warnings.length) return <span className="pill border-warn/50 text-warn">{v.warnings.length > 1 ? t("{n} warnings", { n: v.warnings.length }) : t("{n} warning", { n: v.warnings.length })}</span>;
  return <span className="pill border-accent/50 text-accent-ink">{t("valid")}</span>;
}

function EventDetail({ e, t, lang }: { e: DebugEvent; t: T; lang: Lang }) {
  const v = e.validation;
  const when = (d: string | Date) => new Date(d).toLocaleString(dateLocale(lang));
  return (
    <div className="space-y-3 text-sm">
      <div>
        <p className="font-mono font-medium">{e.event_name}</p>
        <p className="text-xs text-ink-3">event_id {e.event_id}</p>
      </div>
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-ink-3">{t("Occurred")}</dt><dd>{when(e.timestamp)}</dd>
        <dt className="text-ink-3">{t("Received")}</dt><dd>{when(e.received_at)}</dd>
        <dt className="text-ink-3">{t("User id")}</dt><dd className="break-all font-mono">{e.user_id ?? "–"}</dd>
        <dt className="text-ink-3">{t("Anonymous id")}</dt><dd className="break-all font-mono">{e.anonymous_id ?? "–"}</dd>
        <dt className="text-ink-3">{t("Session")}</dt><dd className="break-all font-mono">{e.session_id ?? "–"}</dd>
        <dt className="text-ink-3">{t("Source")}</dt><dd>{e.source}{e.sdk ? ` · ${e.sdk}` : ""}</dd>
        <dt className="text-ink-3">{t("App version")}</dt><dd>{e.app_version ?? "–"}</dd>
        <dt className="text-ink-3">{t("Processed")}</dt><dd>{e.processed ? t("yes") : t("pending")}</dd>
      </dl>
      {v && (v.errors.length > 0 || v.warnings.length > 0) && (
        <ul className="space-y-1">
          {v.errors.map((x, i) => <li key={`e${i}`} className="rounded bg-alert-soft px-2 py-1 text-xs text-alert">{localizeText(x.message, t, lang)}</li>)}
          {v.warnings.map((x, i) => <li key={`w${i}`} className="rounded bg-warn-soft px-2 py-1 text-xs">{localizeText(x.message, t, lang)}</li>)}
        </ul>
      )}
      <Json title={t("Properties")} value={e.properties} />
      {e.user_properties && <Json title={t("User properties")} value={e.user_properties} />}
      <Json title={t("Context")} value={e.context} />
    </div>
  );
}

function Json({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 eyebrow">{title}</p>
      <pre className="code max-h-64 overflow-auto text-xs" dir="ltr">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

function Stat({ label, value, accent, warn, hint }: { label: string; value: string; accent?: boolean; warn?: boolean; hint?: string }) {
  return (
    <div className="card">
      <p className="eyebrow">{label}</p>
      <p className={`mt-1 truncate text-lg font-bold ${accent ? "text-accent-ink" : ""} ${warn ? "text-warn" : ""}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: [string, number][] }) {
  return (
    <div className="card text-sm">
      <p className="eyebrow">{title}</p>
      <ul className="mt-2 space-y-1">
        {rows.length === 0 && <li className="text-ink-3">–</li>}
        {rows.map(([k, n]) => <li key={k} className="flex justify-between gap-2"><span className="truncate">{k}</span><span className="font-mono text-ink-3">{n}</span></li>)}
      </ul>
    </div>
  );
}
