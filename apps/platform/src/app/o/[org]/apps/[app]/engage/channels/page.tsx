import Link from "next/link";
import { testSendAction } from "@/app/actions/campaigns";
import { ActionForm } from "@/components/ActionForm";
import { fmtDate } from "@/components/engage/shared";
import { getLang, getT } from "@/i18n/server";
import { msg, type Lang, type T } from "@/i18n/translate";
import { deliveryByChannel } from "@/modules/messaging/delivery";
import { listIntegrations, type IntegrationRow } from "@/modules/messaging/integrations";
import { DELIVERY_CHANNEL_LABELS, DELIVERY_CHANNELS, FUNNEL_METRICS, OPENED_MEANS, rateOf, UNAVAILABLE, type DeliveryChannel } from "@/modules/messaging/metrics";
import { can } from "@/modules/rbac/authorize";
import { listTemplates } from "@/modules/whatsapp/service";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Channels & delivery") };
}

const PROVIDERS: Record<DeliveryChannel, IntegrationRow["provider"][]> = { push: ["fcm", "apns"], email: ["resend"], whatsapp: ["whatsapp", "twilio"], sms: ["twilio"], in_app: [] };
const PROVIDER_NAMES: Record<string, string> = { fcm: "FCM", apns: "APNs", resend: "Resend", whatsapp: "WhatsApp Cloud API", twilio: "Twilio" };
const RANGES = [7, 30] as const;
const pct = (x: number | null) => (x === null ? "" : ` (${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%)`);

type Health = { label: string; tone: "ok" | "warn" | "bad" | "none"; detail: string };

function health(rows: IntegrationRow[], t: T, lang: Lang): Health {
  if (!rows.length) return { label: t("Not connected"), tone: "none", detail: t("Messages on this channel are logged as failed until it's connected.") };
  const broken = rows.find((r) => r.last_error);
  if (broken) return { label: t("Error"), tone: "bad", detail: t("{provider}: {error} (last used {date})", { provider: PROVIDER_NAMES[broken.provider], error: String(broken.last_error), date: fmtDate(broken.last_used_at, lang) }) };
  const live = rows.filter((r) => r.live_verified_at);
  if (live.length) return { label: t("Verified"), tone: "ok", detail: t("A real send through {providers} succeeded {date}.", { providers: live.map((r) => PROVIDER_NAMES[r.provider]).join(` ${t("and")} `), date: fmtDate(live[0].live_verified_at, lang) }) };
  return { label: t("Connected, not verified"), tone: "warn", detail: t("No real send has succeeded yet. Send a test to confirm it works.") };
}
const METRIC_TEXT: Record<string, string> = { delivered: msg("Delivered"), opened: msg("Opened"), clicked: msg("Clicked") };
const TEST_HELP: Record<DeliveryChannel, string> = {
  push: msg("Goes to every active device of the person."),
  email: msg("Goes to the person's email user property, with an unsubscribe link."),
  in_app: msg("Queued for the person; your app shows it when it next asks for messages."),
  whatsapp: msg("WhatsApp only allows approved templates to start a conversation."),
  sms: msg("Goes to the person's phone number property through Twilio. Text only."),
};
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
  const waTemplates = templates.filter((w) => w.status === "APPROVED" && w.header_params === 0 && !["IMAGE", "VIDEO", "DOCUMENT", "LOCATION"].includes(w.header_format ?? ""));
  const [t, lang] = await Promise.all([getT(), getLang()]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("Channels & delivery")}</h1>
          <p className="mt-1 max-w-3xl text-ink-2">
            {t("Whether each channel works in {env}, and what happened to the messages campaigns and flows sent. A number a provider doesn't report is shown as not available, never estimated.", { env: t(env.type) })}{" "}
            {t("Credentials are set in")} <Link className="underline" href={`${base}/settings/dev-ops/channels?env=${env.type}`}>{t("Settings → Dev Ops → Channels")}</Link>.
          </p>
        </div>
        <nav className="flex gap-2 text-sm" aria-label={t("Range")}>
          {RANGES.map((d) => <Link key={d} href={`?env=${env.type}&days=${d}`} className={`pill ${d === days ? "border-ink bg-ink text-paper" : "border-line"}`}>{t("Last {n} days", { n: d })}</Link>)}
        </nav>
      </div>

      {DELIVERY_CHANNELS.map((c) => {
        const h = c === "in_app"
          ? { label: t("Beta"), tone: "warn" as const, detail: t("No provider needed. Your app fetches messages from the in-app API and reports when they're shown or clicked; the SDKs don't include an in-app message UI yet.") }
          : integrations === null ? { label: t("Unknown"), tone: "none" as const, detail: t("You don't have access to channel settings.") } : health(integrations.filter((r) => PROVIDERS[c].includes(r.provider)), t, lang);
        const n = counts[c];
        return (
          <section key={c} className="card space-y-4" aria-label={t(DELIVERY_CHANNEL_LABELS[c])} data-channel={c}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="h2">{t(DELIVERY_CHANNEL_LABELS[c])} <span className={`pill ms-1 align-middle text-xs ${TONE[h.tone]}`}>{h.label}</span></h2>
                <p className="text-sm text-ink-3">{h.detail}</p>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div><dt className="text-xs text-ink-3">{t("Sent")}</dt><dd className="text-xl font-semibold tabular-nums">{n.sent.toLocaleString("en-US")}</dd></div>
              {FUNNEL_METRICS.map((m) => (
                <div key={m}>
                  <dt className="text-xs text-ink-3">{t(METRIC_TEXT[m])}</dt>
                  {n[m] === null
                    ? <dd className="text-xs text-ink-3">{t("Not available.")} {t(UNAVAILABLE[c][m] ?? "")}</dd>
                    : <dd className="text-xl font-semibold tabular-nums">{n[m]!.toLocaleString("en-US")}<span className="text-sm font-normal text-ink-3">{pct(rateOf(n[m], n.sent))}</span></dd>}
                </div>
              ))}
              <div><dt className="text-xs text-ink-3">{t("Failed")}</dt><dd className="text-xl font-semibold tabular-nums">{c === "in_app" ? <span className="text-xs font-normal text-ink-3">{t("Not applicable: in-app messages aren't handed to a provider.")}</span> : n.failed.toLocaleString("en-US")}</dd></div>
            </dl>
            {OPENED_MEANS[c] && <p className="text-xs text-ink-3">{t("Opened: {meaning}", { meaning: t(OPENED_MEANS[c]) })}</p>}

            {manage && (
              <details className="border-t border-line pt-3">
                <summary className="cursor-pointer text-sm font-medium">{t("Send a test")}</summary>
                <ActionForm action={testSendAction.bind(null, org, env.id, c)} submitLabel={t("Send {channel} test", { channel: t(DELIVERY_CHANNEL_LABELS[c]) })} className="mt-3 max-w-xl space-y-3">
                  <label className="block"><span className="label">{t("User ID (a person your app identified in {env})", { env: t(env.type) })}</span><input name="userId" className="input" required maxLength={200} /></label>
                  {c === "sms" && <label className="block max-w-xs"><span className="label">{t("Phone number property")}</span><input name="phoneProperty" className="input" defaultValue="phone" /></label>}
                  {c === "whatsapp" && (
                    waTemplates.length ? (
                      <>
                        <label className="block"><span className="label">{t("Approved template")}</span>
                          <select name="whatsappTemplate" className="input">{waTemplates.map((w) => <option key={w.id} value={`${w.name}|${w.language}|${w.provider}`}>{t("{name} ({language}, {n} variables)", { name: w.name, language: w.language, n: w.body_params })}{w.provider === "twilio" ? " · Twilio" : ""}</option>)}</select>
                        </label>
                        <label className="block"><span className="label">{t("Variables, one per line")}</span><textarea name="whatsappParams" className="input min-h-16" /></label>
                        <label className="block max-w-xs"><span className="label">{t("Phone number property")}</span><input name="phoneProperty" className="input" defaultValue="phone" /></label>
                      </>
                    ) : <p className="text-sm text-ink-3">{t("No approved templates are synced, so WhatsApp can't send a test yet.")}</p>
                  )}
                  <p className="help">
                    {t(TEST_HELP[c])}
                    {" "}{t("People who opted out or are suppressed are not messaged. At most 20 tests an hour.")}
                  </p>
                </ActionForm>
              </details>
            )}
          </section>
        );
      })}
      <p className="text-xs text-ink-3">{t("Counts cover messages from campaigns and flows created in the last {n} days. Test sends are not counted.", { n: days })}</p>
    </div>
  );
}
