import Link from "next/link";
import { testSendAction } from "@/app/actions/campaigns";
import { ActionForm } from "@/components/ActionForm";
import { fmtDate } from "@/components/engage/shared";
import { deliveryByChannel } from "@/modules/messaging/delivery";
import { listIntegrations, type IntegrationRow } from "@/modules/messaging/integrations";
import { DELIVERY_CHANNEL_LABELS, DELIVERY_CHANNELS, FUNNEL_METRICS, OPENED_MEANS, rateOf, UNAVAILABLE, type DeliveryChannel } from "@/modules/messaging/metrics";
import { can } from "@/modules/rbac/authorize";
import { listTemplates } from "@/modules/whatsapp/service";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Channels & delivery" };

const PROVIDERS: Record<DeliveryChannel, IntegrationRow["provider"][]> = { push: ["fcm", "apns"], email: ["resend"], whatsapp: ["whatsapp"], in_app: [] };
const PROVIDER_NAMES: Record<string, string> = { fcm: "FCM", apns: "APNs", resend: "Resend", whatsapp: "WhatsApp Cloud API" };
const RANGES = [7, 30] as const;
const pct = (x: number | null) => (x === null ? "" : ` (${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%)`);

type Health = { label: string; tone: "ok" | "warn" | "bad" | "none"; detail: string };

function health(rows: IntegrationRow[]): Health {
  if (!rows.length) return { label: "Not connected", tone: "none", detail: "Messages on this channel are logged as failed until it's connected." };
  const broken = rows.find((r) => r.last_error);
  if (broken) return { label: "Error", tone: "bad", detail: `${PROVIDER_NAMES[broken.provider]}: ${broken.last_error} (last used ${fmtDate(broken.last_used_at)})` };
  const live = rows.filter((r) => r.live_verified_at);
  if (live.length) return { label: "Verified", tone: "ok", detail: `A real send through ${live.map((r) => PROVIDER_NAMES[r.provider]).join(" and ")} succeeded ${fmtDate(live[0].live_verified_at)}.` };
  return { label: "Connected, not verified", tone: "warn", detail: "No real send has succeeded yet. Send a test to confirm it works." };
}
const TONE = { ok: "border-accent/40 bg-accent-soft text-accent-ink", warn: "border-warn/40 bg-warn-soft text-warn", bad: "border-alert/40 bg-alert-soft text-alert", none: "border-line text-ink-3" };

export default async function ChannelsPage(props: PageProps<"/o/[org]/apps/[app]/engage/channels">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "automations.read");
  const env = await pickEnvironment(environments, sp.env);
  const days = RANGES.find((d) => String(d) === sp.days) ?? 30;
  const manage = can(ctx.role, "automations.manage");
  const [counts, integrations, templates] = await Promise.all([
    deliveryByChannel(ctx, env.id, days),
    can(ctx.role, "integrations.read") ? listIntegrations(ctx, env.id) : Promise.resolve(null),
    manage ? listTemplates(ctx, env.id) : Promise.resolve([]),
  ]);
  const base = `/o/${org}/apps/${app}`;
  const waTemplates = templates.filter((t) => t.status === "APPROVED" && t.header_params === 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Channels &amp; delivery</h1>
          <p className="mt-1 max-w-3xl text-ink-2">
            Whether each channel works in <strong>{env.type}</strong>, and what happened to the messages campaigns and flows sent. A number a provider doesn&apos;t report is shown as not available, never estimated.
            Credentials are set in <Link className="underline" href={`${base}/settings/dev-ops/channels?env=${env.type}`}>Settings → Dev Ops → Channels</Link>.
          </p>
        </div>
        <nav className="flex gap-2 text-sm" aria-label="Range">
          {RANGES.map((d) => <Link key={d} href={`?env=${env.type}&days=${d}`} className={`pill ${d === days ? "border-ink bg-ink text-paper" : "border-line"}`}>Last {d} days</Link>)}
        </nav>
      </div>

      {DELIVERY_CHANNELS.map((c) => {
        const h = c === "in_app"
          ? { label: "Beta", tone: "warn" as const, detail: "No provider needed. Your app fetches messages from the in-app API and reports when they're shown or clicked; the SDKs don't include an in-app message UI yet." }
          : integrations === null ? { label: "Unknown", tone: "none" as const, detail: "You don't have access to channel settings." } : health(integrations.filter((r) => PROVIDERS[c].includes(r.provider)));
        const n = counts[c];
        return (
          <section key={c} className="card space-y-4" aria-label={DELIVERY_CHANNEL_LABELS[c]} data-channel={c}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="h2">{DELIVERY_CHANNEL_LABELS[c]} <span className={`pill ms-1 align-middle text-xs ${TONE[h.tone]}`}>{h.label}</span></h2>
                <p className="text-sm text-ink-3">{h.detail}</p>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div><dt className="text-xs text-ink-3">Sent</dt><dd className="text-xl font-semibold tabular-nums">{n.sent.toLocaleString("en-US")}</dd></div>
              {FUNNEL_METRICS.map((m) => (
                <div key={m}>
                  <dt className="text-xs text-ink-3">{m[0].toUpperCase() + m.slice(1)}</dt>
                  {n[m] === null
                    ? <dd className="text-xs text-ink-3">Not available. {UNAVAILABLE[c][m]}</dd>
                    : <dd className="text-xl font-semibold tabular-nums">{n[m]!.toLocaleString("en-US")}<span className="text-sm font-normal text-ink-3">{pct(rateOf(n[m], n.sent))}</span></dd>}
                </div>
              ))}
              <div><dt className="text-xs text-ink-3">Failed</dt><dd className="text-xl font-semibold tabular-nums">{c === "in_app" ? <span className="text-xs font-normal text-ink-3">Not applicable: in-app messages aren&apos;t handed to a provider.</span> : n.failed.toLocaleString("en-US")}</dd></div>
            </dl>
            {OPENED_MEANS[c] && <p className="text-xs text-ink-3">Opened: {OPENED_MEANS[c]}</p>}

            {manage && (
              <details className="border-t border-line pt-3">
                <summary className="cursor-pointer text-sm font-medium">Send a test</summary>
                <ActionForm action={testSendAction.bind(null, org, env.id, c)} submitLabel={`Send ${DELIVERY_CHANNEL_LABELS[c]} test`} className="mt-3 max-w-xl space-y-3">
                  <label className="block"><span className="label">User ID (a person your app identified in {env.type})</span><input name="userId" className="input" required maxLength={200} /></label>
                  {c === "whatsapp" && (
                    waTemplates.length ? (
                      <>
                        <label className="block"><span className="label">Approved template</span>
                          <select name="whatsappTemplate" className="input">{waTemplates.map((t) => <option key={t.id} value={`${t.name}|${t.language}`}>{t.name} ({t.language}, {t.body_params} variables)</option>)}</select>
                        </label>
                        <label className="block"><span className="label">Variables, one per line</span><textarea name="whatsappParams" className="input min-h-16" /></label>
                        <label className="block max-w-xs"><span className="label">Phone number property</span><input name="phoneProperty" className="input" defaultValue="phone" /></label>
                      </>
                    ) : <p className="text-sm text-ink-3">No approved templates are synced, so WhatsApp can&apos;t send a test yet.</p>
                  )}
                  <p className="help">
                    {c === "push" && "Goes to every active device of the person."}
                    {c === "email" && "Goes to the person's email user property, with an unsubscribe link."}
                    {c === "in_app" && "Queued for the person; your app shows it when it next asks for messages."}
                    {c === "whatsapp" && "WhatsApp only allows approved templates to start a conversation."}
                    {" "}People who opted out or are suppressed are not messaged. At most 20 tests an hour.
                  </p>
                </ActionForm>
              </details>
            )}
          </section>
        );
      })}
      <p className="text-xs text-ink-3">Counts cover messages from campaigns and flows created in the last {days} days. Test sends are not counted.</p>
    </div>
  );
}
