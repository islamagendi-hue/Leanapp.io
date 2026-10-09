import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AnalyticsHeader, param, rich } from "@/components/AnalyticsHeader";
import { EventName } from "@/components/EventName";
import { getLang, getT } from "@/i18n/server";
import { dateLocale } from "@/i18n/translate";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { eventLabels } from "@/modules/analytics/labels";
import { getProfile, profileTimeline, type PersonRef, type Profile } from "@/modules/analytics/profiles";
import { NO_CURRENCY } from "@/modules/analytics/revenue";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("User profile") };
}

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function ProfilePage(props: PageProps<"/o/[org]/apps/[app]/analytics/users/profile">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "users.read");
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const env = await pickEnvironment(environments, sp.env);
  const userId = param(sp.user);
  const anonymousId = param(sp.anon);
  const ref: PersonRef | null = userId ? { userId } : anonymousId ? { anonymousId } : null;
  const usersPath = `/o/${org}/apps/${app}/analytics/users`;
  const path = `${usersPath}/profile`;
  const link = (q: Record<string, string>) => `${path}?${new URLSearchParams({ env: env.type, ...q })}`;
  if (!ref) redirect(`${usersPath}?env=${env.type}`);

  let p: Profile;
  try {
    const res = await getProfile(ctx, { environmentId: env.id }, ref);
    if ("redirectToUser" in res) redirect(link({ user: res.redirectToUser }));
    p = res;
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ValidationError) notFound();
    throw e;
  }
  const timeline = await profileTimeline(ctx, { environmentId: env.id }, ref, { cursor: param(sp.before) });
  const when = (d: Date | null) => (d ? new Date(d).toLocaleString(dateLocale(lang), { dateStyle: "medium", timeStyle: "medium", timeZone: a.timezone }) : "–");
  const self: Record<string, string> = userId ? { user: userId } : { anon: anonymousId! };
  const props_ = Object.entries(p.properties);
  const label = await eventLabels(ctx, a.id, t);
  const value = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

  return (
    <div className="space-y-6">
      <AnalyticsHeader
        title={p.userId ?? t("Anonymous install")}
        description={p.userId ? t("An identified user, with the activity of installs linked only to them.") : t("Anonymous ID {id}. Not linked to exactly one user, so its activity stays on this install.", { id: p.anonymousId ?? "" })} env={env.type}
      />
      <p className="text-sm"><Link className="underline" href={`${usersPath}?env=${env.type}`}><span aria-hidden className="inline-block rtl:-scale-x-100">←</span> {t("All users")}</Link></p>

      <dl className="card grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label={t("First seen")} value={when(p.firstSeen)} />
        <Stat label={t("Last seen")} value={when(p.lastSeen)} />
        <Stat label={t("Platform")} value={p.platform ?? "–"} hint={p.osVersion ? t("OS {version}", { version: p.osVersion }) : undefined} />
        <Stat label={t("App version")} value={p.appVersion ?? "–"} />
        <Stat label={t("Sessions")} value={p.sessionCount.toLocaleString("en-US")} />
        <Stat label={t("Events")} value={p.eventCount.toLocaleString("en-US")} />
      </dl>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card space-y-3">
          <h2 className="card-title">{t("Identity")}</h2>
          {p.installs.length === 0 ? (
            <p className="text-sm text-ink-3">{t("No installs linked yet.")}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {p.installs.map((i) => (
                <li key={i.anonymousId} className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono">{p.userId && !i.stitched ? <Link className="underline" href={link({ anon: i.anonymousId })}>{i.anonymousId}</Link> : i.anonymousId}</span>
                  <span className="text-ink-3">
                    {i.platform ?? ""}
                    {i.linkedUsers.length > 1 && (
                      <span className="pill ms-2 border-warn/40 text-warn" title={t("Linked to {users}", { users: i.linkedUsers.join(", ") })}>{t("Shared device · not merged")}</span>
                    )}
                    {p.userId && i.stitched && <span className="pill ms-2 border-accent/40 text-accent">{t("Merged")}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {p.installs.some((i) => i.linkedUsers.length > 1) && (
            <p className="text-xs text-ink-3">
              {rich(t("A shared device was used by several users ({users}). Its anonymous activity can't be attributed to any one of them, so it isn't merged."), {
                users: [...new Set(p.installs.flatMap((i) => i.linkedUsers.length > 1 ? i.linkedUsers : []))].map((u, k) => (
                  <span key={u}>{k > 0 && ", "}{u === p.userId ? u : <Link className="underline" href={link({ user: u })}>{u}</Link>}</span>
                )),
              })}
            </p>
          )}
        </section>

        <section className="card space-y-3">
          <h2 className="card-title">{t("Revenue")}</h2>
          {p.revenue.length === 0 ? (
            <p className="text-sm text-ink-3">{t("No revenue events.")}</p>
          ) : (
            <table className="table">
              <thead><tr><th className="text-start">{t("Currency")}</th><th className="num">{t("Net")}</th><th className="num">{t("Refunds")}</th><th className="num">{t("Transactions")}</th></tr></thead>
              <tbody>
                {p.revenue.map((r) => (
                  <tr key={r.currency}>
                    <td>{r.currency === NO_CURRENCY ? t("No currency") : r.currency}</td>
                    <td className="text-end tabular-nums font-medium">{money(r.net)}</td>
                    <td className="text-end tabular-nums">{r.refunds ? `−${money(r.refunds)}` : ""}</td>
                    <td className="text-end tabular-nums">{r.transactions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-xs text-ink-3">{t("All time, per currency (no conversion).")}</p>
        </section>
      </div>

      <section className="card space-y-3">
        <h2 className="card-title">{p.userId ? t("User properties") : t("Anonymous traits")}</h2>
        {props_.length === 0 ? (
          <p className="text-sm text-ink-3">{t("None set. Properties come from identify() calls.")}</p>
        ) : (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {props_.map(([k, v]) => (
              <div key={k} className="flex min-w-0 gap-2">
                <dt className="font-mono text-ink-3">{k}</dt>
                <dd className="min-w-0 truncate font-mono" title={typeof v === "string" ? v : JSON.stringify(v)}>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="card-table">
        <div className="card-header"><h2 className="card-title">{t("Activity")}</h2></div>
        {timeline.events.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-3">{param(sp.before) ? t("No events before this point.") : t("No events.")}</p>
        ) : (
          <div className="table-scroll"><table className="table">
            <thead><tr><th className="text-start">{t("Time ({timezone})", { timezone: a.timezone })}</th><th className="text-start">{t("Event")}</th><th className="text-start">{t("Properties")}</th><th className="hidden text-start sm:table-cell">{t("Platform")}</th></tr></thead>
            <tbody>
              {timeline.events.map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="whitespace-nowrap tabular-nums">{when(e.timestamp)}</td>
                  <td>
                    <span className="text-sm"><EventName name={e.name} labels={label} /></span>
                    {e.type !== "track" && <span className="pill ms-2 border-line text-ink-3">{e.type}</span>}
                    {e.sentAs && <div className="text-xs text-ink-3">{t("sent as {name}", { name: e.sentAs })}</div>}
                    {p.userId && !e.userId && <div className="text-xs text-ink-3">{t("before sign-in · {id}", { id: e.anonymousId ?? "" })}</div>}
                  </td>
                  <td className="max-w-md">
                    {Object.keys(e.properties).length > 0 && (
                      <dl className="flex flex-wrap gap-1.5 text-xs">
                        {Object.entries(e.properties).slice(0, 8).map(([k, v]) => (
                          <div key={k} className="inline-flex max-w-full gap-1 rounded bg-paper-2 px-1.5 py-0.5" title={`${k}: ${value(v)}`}>
                            <dt className="text-ink-3">{k}</dt><dd className="truncate font-medium text-ink">{value(v)}</dd>
                          </div>
                        ))}
                        {Object.keys(e.properties).length > 8 && <div className="px-1 text-ink-3" title={JSON.stringify(e.properties)}>{t("+{n} more", { n: Object.keys(e.properties).length - 8 })}</div>}
                      </dl>
                    )}
                  </td>
                  <td className="hidden whitespace-nowrap text-sm text-ink-2 sm:table-cell">{[e.platform, e.appVersion].filter(Boolean).join(" ")}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        <div className="flex gap-3 px-5 py-3 text-sm">
          {param(sp.before) && <Link className="underline" href={link(self)}>{t("Newest")}</Link>}
          {timeline.nextCursor && <Link className="underline" href={link({ ...self, before: timeline.nextCursor })}>{t("Older events")} <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></Link>}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="truncate text-sm font-medium" title={value}>{value}</dd>
      {hint && <dd className="text-xs text-ink-3">{hint}</dd>}
    </div>
  );
}
