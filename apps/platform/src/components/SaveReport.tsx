import { saveReportAction } from "@/app/actions/analytics";
import { ActionForm } from "@/components/ActionForm";
import type { ReportKind } from "@/modules/analytics/report-params";

/** "Save this report" for users with analytics.write; stores the page's current settings. */
export function SaveReport({ org, app, environmentId, kind, query }: {
  org: string; app: string; environmentId: string; kind: ReportKind; query: Record<string, string | string[] | undefined>;
}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k === "env" || k === "fresh" || v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) q.append(k, item);
  }
  return (
    <details className="card py-3">
      <summary className="cursor-pointer text-sm font-medium">Save this report</summary>
      <ActionForm action={saveReportAction.bind(null, org, app, environmentId, kind, q.toString())} submitLabel="Save report" buttonClass="btn-secondary" className="mt-3 flex flex-wrap items-end gap-3">
        <label className="min-w-56 flex-1"><span className="label">Name</span><input name="name" className="input" maxLength={100} required /></label>
      </ActionForm>
    </details>
  );
}
