import Link from "next/link";
import { deleteSpendAction, importSpendAction, saveSpendAction } from "@/app/actions/attribution-spend";
import { AcquisitionHeader, money } from "@/components/acquisition/AcquisitionHeader";
import { rich } from "@/components/acquisition/rich";
import { ActionForm } from "@/components/ActionForm";
import { getT } from "@/i18n/server";
import { localDate } from "@/modules/analytics/range";
import { knownSources, listSpend } from "@/modules/attribution/spend";
import { CSV_COLUMNS } from "@/modules/attribution/spend-pure";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Ad spend") };
}

export default async function SpendPage(props: PageProps<"/o/[org]/apps/[app]/acquisition/spend">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "attribution.read");
  requirePermission(ctx, "analytics.read");
  const env = await pickEnvironment(environments, sp.env);
  const [rows, sources] = await Promise.all([listSpend(ctx, env.id), knownSources(ctx, env.id)]);
  const manage = can(ctx.role, "attribution.manage");
  const base = `/o/${org}/apps/${app}/acquisition`;
  const today = localDate(new Date(), a.timezone);
  const t = await getT();

  return (
    <div className="space-y-6">
      <AcquisitionHeader base={base} current="/spend" env={env.type} title={t("Ad spend")}
        description={t("Your ad spend per day, source and campaign, entered by hand or by CSV. Revenue by channel shows it next to revenue, with return and ROAS. Automatic import from ad networks is coming.")} />

      {manage && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="card space-y-4">
            <h2 className="h2">{t("Add a day's spend")}</h2>
            <ActionForm action={saveSpendAction.bind(null, org, app)} submitLabel={t("Save spend")} className="space-y-4">
              <input type="hidden" name="env" value={env.type} />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block"><span className="label">{t("Date")}</span><input type="date" name="date" className="input" required defaultValue={today} max={today} /></label>
                <label className="block"><span className="label">{t("Source")}</span><input name="source" className="input" required maxLength={100} list="spend-sources" placeholder="tiktok, meta, google…" dir="ltr" /></label>
                <label className="block"><span className="label">{t("Campaign (optional)")}</span><input name="campaign" className="input" maxLength={100} dir="ltr" /></label>
                <label className="block"><span className="label">{t("Currency")}</span><input name="currency" className="input" required pattern="[A-Za-z]{3}" maxLength={3} defaultValue={a.default_currency} dir="ltr" /></label>
                <label className="block"><span className="label">{t("Amount")}</span><input name="amount" className="input" required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" placeholder="1250.00" dir="ltr" /></label>
              </div>
              <datalist id="spend-sources">{sources.map((s) => <option key={s} value={s} />)}</datalist>
              {/* The source must match Acquisition's label for the spend to line up with that channel's revenue. */}
              <div className="space-y-1 text-xs text-ink-3">
                <p>{t("Write the source exactly as Acquisition shows it.")}</p>
                <p>{t("Saving the same entry again replaces its amount.")}</p>
              </div>
            </ActionForm>
          </section>

          <section className="card space-y-4">
            <h2 className="h2">{t("Import a CSV")}</h2>
            <ActionForm action={importSpendAction.bind(null, org, app)} submitLabel={t("Import")} className="space-y-4">
              <input type="hidden" name="env" value={env.type} />
              <div className="space-y-1 text-sm text-ink-2">
                <p>{t("One row per day, with these columns:")}</p>
                <code className="block font-mono text-xs" dir="ltr">{CSV_COLUMNS.join(",")}</code>
                <p>{t("The header row and the campaign are optional.")}</p>
              </div>
              <label className="block"><span className="label">{t("Paste CSV")}</span>
                <textarea name="csv" className="input min-h-32 font-mono text-xs" dir="ltr" placeholder={`${CSV_COLUMNS.join(",")}\n${today},tiktok,ramadan,${a.default_currency},1250.00`} />
              </label>
              <label className="block"><span className="label">{t("Or upload a file")}</span><input type="file" name="file" accept=".csv,text/csv" className="input" /></label>
              <p className="text-xs text-ink-3">{t("One wrong row stops the import; wrong lines are listed.")}</p>
            </ActionForm>
          </section>
        </div>
      )}

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-5">{t("Entries")}</h2>
        {rows.length === 0 ? (
          <p className="px-5 pb-5 pt-3 text-sm text-ink-3">{t("No spend entered in this environment yet.")}</p>
        ) : (
          <table className="table mt-3" data-testid="spend-entries">
            <thead><tr><th>{t("Date")}</th><th>{t("Source")}</th><th>{t("Campaign")}</th><th>{t("Currency")}</th><th className="text-end">{t("Amount")}</th>{manage && <th></th>}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="tabular-nums" dir="ltr">{r.date}</td>
                  <td>{r.source}</td>
                  <td className="text-ink-2">{r.campaign ?? "–"}</td>
                  <td>{r.currency}</td>
                  <td className="text-end tabular-nums">{money(r.amount)}</td>
                  {manage && (
                    <td>
                      <ActionForm action={deleteSpendAction.bind(null, org, app, r.id)} submitLabel={t("Delete")} buttonClass="btn-secondary min-h-8 px-3" className="" confirm={t("Delete this spend entry?")} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="px-5 pb-5 pt-3 text-sm text-ink-3">
          {rich(t("Return and ROAS for each channel are shown in {revenue}, broken down by channel."), {
            revenue: <Link className="underline" href={`/o/${org}/apps/${app}/analytics/revenue?env=${env.type}&by=channel`}>{t("Revenue")}</Link>,
          })}
        </p>
      </section>
    </div>
  );
}
