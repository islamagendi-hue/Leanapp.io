import Link from "next/link";
import { saveGrowthDefinitionAction } from "@/app/actions/growth";
import { ActionForm } from "@/components/ActionForm";
import { DefinitionList } from "@/components/GrowthDefinitionList";
import { PROPERTY_OP_LABELS, PROPERTY_OPS } from "@/modules/analytics/sql";
import { definitionInputFromFields, fieldsFromDefinition, growthDefinitionSchema, type GrowthDefinition } from "@/modules/growth/definition";
import { growthDefinitions, previewDefinition, type GrowthSummary } from "@/modules/growth/service";
import { readPlan } from "@/modules/implementation/editor";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Growth setup" };

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 1000) / 10}%` : "–");

function RuleFields({ prefix, label, help, events, values, properties }: {
  prefix: string; label: string; help: string; events: string[]; values: Record<string, string>; properties: string[];
}) {
  return (
    <fieldset className="space-y-2 rounded-lg border border-line p-3">
      <legend className="px-1 font-medium">{label}</legend>
      <p className="text-xs text-ink-3">{help}</p>
      <label className="block"><span className="label">Event</span>
        <select name={`${prefix}_event`} className="input" defaultValue={values[`${prefix}_event`] ?? ""}>
          <option value="">Not set</option>
          {events.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </label>
      <div className="grid gap-2 sm:grid-cols-3">
        <label><span className="label">Only when property</span><input name={`${prefix}_filter_name`} list="growth-properties" className="input" defaultValue={values[`${prefix}_filter_name`] ?? ""} placeholder="optional" /></label>
        <label><span className="label">is</span>
          <select name={`${prefix}_filter_op`} className="input" defaultValue={values[`${prefix}_filter_op`] ?? "eq"}>
            {PROPERTY_OPS.map((op) => <option key={op} value={op}>{PROPERTY_OP_LABELS[op]}</option>)}
          </select>
        </label>
        <label><span className="label">Value</span><input name={`${prefix}_filter_value`} className="input" defaultValue={values[`${prefix}_filter_value`] ?? ""} /></label>
      </div>
      <datalist id="growth-properties">{properties.map((p) => <option key={p} value={p} />)}</datalist>
    </fieldset>
  );
}

function Preview({ p, days }: { p: GrowthSummary; days: number }) {
  return (
    <div className="card space-y-2">
      <h2 className="h2">Preview: last {days} days</h2>
      <p className="text-sm text-ink-3">Computed from this environment&apos;s events of the last {days} days, as if that were all of history. Nothing is saved.</p>
      <ul className="grid gap-2 text-sm sm:grid-cols-2">
        <li>People: <span className="font-mono">{p.people}</span></li>
        <li>Activated: <span className="font-mono">{p.activated} ({pct(p.activated, p.people)})</span></li>
        <li>Did the core action: <span className="font-mono">{p.core_people} ({pct(p.core_people, p.people)})</span></li>
        <li>Paying: <span className="font-mono">{p.paying} ({pct(p.paying, p.people)}), {p.purchases} purchases</span></li>
        <li>Revenue: <span className="font-mono">{p.revenue.length ? p.revenue.map((r) => `${r.total.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${r.currency}`).join(", ") : "none"}</span></li>
        <li>Retention: <span className="font-mono">{p.retention.map((r) => `D${r.day} ${pct(r.retained, r.eligible)}`).join(" · ")}</span></li>
      </ul>
    </div>
  );
}

export default async function GrowthSetupPage(props: PageProps<"/o/[org]/apps/[app]/growth/setup">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  // Definitions are built from the tracking plan, which read-only viewers can't open.
  requirePermission(ctx, "implementation.read");
  const env = await pickEnvironment(environments, sp.env);
  const base = `/o/${org}/apps/${app}`;
  const defs = await growthDefinitions(ctx, a.id);
  const canEdit = can(ctx.role, "growth.write");
  const plan = await readPlan({ kind: "user", ctx }, a.id, defs.draft?.versionId ?? "published");
  const events = (plan?.events ?? []).map((e) => e.event_name);
  const properties = [...new Set((plan?.events ?? []).flatMap((e) => e.properties.map((p) => p.name)))].sort();
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]);

  // What the form shows: what was just previewed, else the draft, else the published definitions.
  const previewing = one("preview") === "1";
  let candidate: GrowthDefinition | null = null;
  let problem: string | null = null;
  if (previewing) {
    const parsed = growthDefinitionSchema.safeParse(definitionInputFromFields(one));
    if (parsed.success) candidate = parsed.data;
    else problem = parsed.error.issues.map((i) => i.message).join(" ");
  }
  const current = defs.draft?.definition ?? defs.published?.definition ?? null;
  const values = previewing ? Object.fromEntries(Object.keys(sp).map((k) => [k, one(k) ?? ""])) : current ? fieldsFromDefinition(current) : {};
  const preview = candidate ? await previewDefinition(ctx, a.id, env.id, candidate) : null;

  if (!plan) {
    return (
      <div className="space-y-6">
        <h1 className="h1">Growth setup</h1>
        <div className="card">
          <p>Growth definitions are saved with the tracking plan. Create a tracking plan first.</p>
          <Link href={`${base}/settings/dev-ops/implementation/plan`} className="btn mt-4">Open tracking plan</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">Growth setup</h1>
        <p className="mt-1 text-ink-2">
          Define what activation, the core action, revenue and retention mean for this app. They are saved in the draft tracking plan and apply once that draft is approved and published.
        </p>
      </div>

      <form method="get" className="grid gap-4 lg:grid-cols-2">
        <input type="hidden" name="preview" value="1" />
        <input type="hidden" name="env" value={env.type} />
        <RuleFields prefix="act" label="Activation" help="The first moment a person gets real value, e.g. their first order or a completed signup." events={events} values={values} properties={properties} />
        <RuleFields prefix="core" label="Core action" help="The action you want people to repeat. Counted every time." events={events} values={values} properties={properties} />
        <fieldset className="space-y-2 rounded-lg border border-line p-3">
          <legend className="px-1 font-medium">Revenue</legend>
          <p className="text-xs text-ink-3">The event that carries money. Amounts must be numbers (or numeric text); a missing or invalid currency counts as {a.default_currency}.</p>
          <label className="block"><span className="label">Event</span>
            <select name="rev_event" className="input" defaultValue={values.rev_event ?? ""}>
              <option value="">Not set</option>
              {events.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label><span className="label">Amount property</span><input name="rev_amount" list="growth-properties" className="input" defaultValue={values.rev_amount ?? "revenue"} /></label>
            <label><span className="label">Currency property</span><input name="rev_currency" list="growth-properties" className="input" defaultValue={values.rev_currency ?? "currency"} /></label>
          </div>
        </fieldset>
        <fieldset className="space-y-2 rounded-lg border border-line p-3">
          <legend className="px-1 font-medium">Retention</legend>
          <p className="text-xs text-ink-3">A person is retained on day 1, 7 and 30 when they come back on or after that day.</p>
          <label className="block"><span className="label">Counts as coming back</span>
            <select name="return_event" className="input" defaultValue={values.return_event ?? "any"}>
              <option value="any">Any event</option>
              <option value="core_action">The core action</option>
            </select>
          </label>
        </fieldset>
        <div className="lg:col-span-2"><button className="btn" type="submit">Preview on the last 30 days</button></div>
      </form>

      {problem && <p className="text-sm text-alert" role="alert">{problem}</p>}
      {preview && <Preview p={preview} days={30} />}

      {candidate && canEdit && (
        <div className="card space-y-3">
          <h2 className="h2">Save these definitions</h2>
          <DefinitionList def={candidate} />
          <ActionForm action={saveGrowthDefinitionAction.bind(null, org, app, a.id)} submitLabel={`Save to draft${defs.draft ? ` v${defs.draft.version}` : ""}`} className="space-y-3">
            {Object.entries(fieldsFromDefinition(candidate)).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          </ActionForm>
          <p className="text-xs text-ink-3">Then approve and publish the draft on the <Link className="underline" href={`${base}/settings/dev-ops/implementation/plan`}>tracking plan</Link> page. Publishing rebuilds growth state from all events.</p>
        </div>
      )}
      {!canEdit && <p className="text-sm text-ink-3">You can preview definitions; saving them needs the growth.write permission (owner, admin or developer).</p>}
    </div>
  );
}
