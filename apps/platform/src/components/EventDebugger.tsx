"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionHealth, DebugEvent } from "@/modules/debugger/service";

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

  const poll = useCallback(async () => {
    try {
      const url = lastId.current ? `${feedUrl}?after=${lastId.current}` : feedUrl;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 401 ? "Your session expired. Sign in again." : `Feed returned ${res.status}`);
      const data = (await res.json()) as { events: DebugEvent[]; health: ConnectionHealth };
      setHealth(data.health);
      setError(null);
      if (data.events.length) {
        lastId.current = data.events[0].id;
        setEvents((prev) => [...data.events, ...prev].slice(0, MAX_EVENTS));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Feed unavailable");
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
      <div className="grid gap-4 md:grid-cols-5">
        <Stat label="Status" value={health ? (health.connected ? "Connected" : "Waiting for first event") : "…"} accent={health?.connected} />
        <Stat label="Last event" value={health?.lastEventAt ? new Date(health.lastEventAt).toLocaleTimeString("en-GB") : "–"} />
        <Stat label="Events today" value={String(health?.eventsToday ?? "–")} />
        <Stat label="Active users today" value={String(health?.activeUsersToday ?? "–")} />
        <Stat label="Rejected today" value={String(health?.rejectedToday ?? "–")} warn={!!health?.rejectedToday} />
      </div>

      {health && !health.connected && (
        <div className="card text-sm">
          <p className="font-medium">No events yet in this environment.</p>
          <p className="mt-1 text-ink-2">Send a test event from your terminal. It shows up here within a couple of seconds.</p>
          <pre className="code mt-3 overflow-x-auto whitespace-pre text-xs">{testCurl}</pre>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <span className={`inline-flex items-center gap-2 text-sm ${paused ? "text-ink-3" : "text-accent-ink"}`}>
          <span className={`size-2 rounded-full ${paused ? "bg-ink-3" : "animate-pulse bg-accent"}`} />
          {paused ? "Paused" : "Live"}
        </span>
        <button type="button" className="btn-secondary" onClick={() => setPaused((p) => !p)}>{paused ? "Resume" : "Pause"}</button>
        <button type="button" className="btn-secondary" onClick={() => { setEvents([]); setSelected(null); }}>Clear view</button>
        <input className="input max-w-xs" placeholder="Filter by event or user id" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {error && <span className="text-sm text-alert" role="alert">{error}</span>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead><tr><th>Received</th><th>Event</th><th>User</th><th>Platform</th><th>Check</th></tr></thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-ink-3">Listening for events…</td></tr>}
              {shown.map((e) => (
                <tr key={e.id} onClick={() => setSelected(e.id)} className={`cursor-pointer hover:bg-paper-2 ${selected === e.id ? "bg-accent-soft" : ""}`}>
                  <td className="whitespace-nowrap font-mono text-xs text-ink-3">{new Date(e.received_at).toLocaleTimeString("en-GB")}</td>
                  <td>
                    <span className="font-mono text-sm">{e.event_name}</span>
                    {e.canonical_name && <span className="ms-1 font-mono text-xs text-ink-3">→ {e.canonical_name}</span>}
                    {e.type !== "track" && <span className="pill ms-2 border-line text-ink-3">{e.type}</span>}
                  </td>
                  <td className="max-w-[160px] truncate font-mono text-xs">{e.user_id ?? <span className="text-ink-3">anon {e.anonymous_id?.slice(0, 8)}</span>}</td>
                  <td className="text-xs text-ink-2">{e.platform ?? e.source}</td>
                  <td><Badge e={e} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card min-w-0 lg:sticky lg:top-20 lg:self-start">
          {current ? <EventDetail e={current} /> : <p className="text-sm text-ink-3">Click an event to inspect its payload and validation.</p>}
        </div>
      </div>

      {health && health.connected && (
        <div className="grid gap-4 md:grid-cols-3">
          <Breakdown title="SDK versions (7 days)" rows={health.sdkVersions.map((r) => [r.sdk, r.events])} />
          <Breakdown title="Platforms (7 days)" rows={health.platforms.map((r) => [r.platform, r.events])} />
          <Breakdown title="App versions (7 days)" rows={health.appVersions.map((r) => [r.app_version, r.events])} />
        </div>
      )}
    </div>
  );
}

function Badge({ e }: { e: DebugEvent }) {
  const v = e.validation;
  if (!v) return <span className="text-xs text-ink-3">no plan</span>;
  if (!v.valid) return <span className="pill border-alert/50 text-alert">{v.errors.length} error{v.errors.length > 1 ? "s" : ""}</span>;
  if (!v.planned) return <span className="pill border-warn/50 text-warn">unplanned</span>;
  if (v.warnings.length) return <span className="pill border-warn/50 text-warn">{v.warnings.length} warning{v.warnings.length > 1 ? "s" : ""}</span>;
  return <span className="pill border-accent/50 text-accent-ink">valid</span>;
}

function EventDetail({ e }: { e: DebugEvent }) {
  const v = e.validation;
  return (
    <div className="space-y-3 text-sm">
      <div>
        <p className="font-mono font-medium">{e.event_name}</p>
        <p className="text-xs text-ink-3">event_id {e.event_id}</p>
      </div>
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-ink-3">Occurred</dt><dd>{new Date(e.timestamp).toLocaleString("en-GB")}</dd>
        <dt className="text-ink-3">Received</dt><dd>{new Date(e.received_at).toLocaleString("en-GB")}</dd>
        <dt className="text-ink-3">User id</dt><dd className="break-all font-mono">{e.user_id ?? "–"}</dd>
        <dt className="text-ink-3">Anonymous id</dt><dd className="break-all font-mono">{e.anonymous_id ?? "–"}</dd>
        <dt className="text-ink-3">Session</dt><dd className="break-all font-mono">{e.session_id ?? "–"}</dd>
        <dt className="text-ink-3">Source</dt><dd>{e.source}{e.sdk ? ` · ${e.sdk}` : ""}</dd>
        <dt className="text-ink-3">App version</dt><dd>{e.app_version ?? "–"}</dd>
        <dt className="text-ink-3">Processed</dt><dd>{e.processed ? "yes" : "pending"}</dd>
      </dl>
      {v && (v.errors.length > 0 || v.warnings.length > 0) && (
        <ul className="space-y-1">
          {v.errors.map((x, i) => <li key={`e${i}`} className="rounded bg-alert-soft px-2 py-1 text-xs text-alert">{x.message}</li>)}
          {v.warnings.map((x, i) => <li key={`w${i}`} className="rounded bg-warn-soft px-2 py-1 text-xs">{x.message}</li>)}
        </ul>
      )}
      <Json title="Properties" value={e.properties} />
      {e.user_properties && <Json title="User properties" value={e.user_properties} />}
      <Json title="Context" value={e.context} />
    </div>
  );
}

function Json({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 font-mono text-[11px] uppercase tracking-wide text-ink-3">{title}</p>
      <pre className="code max-h-64 overflow-auto text-xs">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

function Stat({ label, value, accent, warn }: { label: string; value: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className="card">
      <p className="font-mono text-[11px] uppercase tracking-wide text-ink-3">{label}</p>
      <p className={`mt-1 truncate text-lg font-bold ${accent ? "text-accent-ink" : ""} ${warn ? "text-warn" : ""}`}>{value}</p>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: [string, number][] }) {
  return (
    <div className="card text-sm">
      <p className="font-mono text-[11px] uppercase tracking-wide text-ink-3">{title}</p>
      <ul className="mt-2 space-y-1">
        {rows.length === 0 && <li className="text-ink-3">–</li>}
        {rows.map(([k, n]) => <li key={k} className="flex justify-between gap-2"><span className="truncate">{k}</span><span className="font-mono text-ink-3">{n}</span></li>)}
      </ul>
    </div>
  );
}
