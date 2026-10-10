import { getT } from "@/i18n/server";
import { describeStep, describeTrigger, type AutomationDefinition } from "@/modules/automation/definition";
import { flowNodes } from "@/modules/automation/flow";

const TONE: Record<string, string> = { delay: "border-s-ink-3", branch: "border-s-warn", exit: "border-s-alert", push: "border-s-accent", in_app: "border-s-accent", email: "border-s-accent", whatsapp: "border-s-accent", whatsapp_session: "border-s-accent", sms: "border-s-accent", wait_outcome: "border-s-warn" };

/** A flow drawn top to bottom: trigger, steps (branches with their yes / no paths), end. Read-only. */
export async function FlowView({ definition: d, audienceName }: { definition: AutomationDefinition; audienceName: (id: string) => string }) {
  const t = await getT();
  const nodes = flowNodes(d.steps);
  const line = <span className="mx-auto block h-4 w-px bg-line-strong" aria-hidden />;
  return (
    <ol className="max-w-2xl text-sm" aria-label={t("Flow")}>
      <li className="rounded-lg border border-line border-s-4 border-s-ink bg-card px-3 py-2"><span className="text-xs text-ink-3">{t("Trigger")}</span><p>{describeTrigger(d.trigger, audienceName, t)}</p></li>
      {d.steps.map((s, i) => (
        <li key={i}>
          {line}
          <div className={`rounded-lg border border-line border-s-4 bg-card px-3 py-2 ${TONE[s.type] ?? "border-s-line-strong"}`}>
            <span className="text-xs text-ink-3">{t("Step {n}", { n: i + 1 })}</span>
            <p>{describeStep(s, t)}</p>
            {s.type === "branch" && (
              <p className="mt-1 flex flex-wrap gap-2 text-xs">
                <span className="pill border-accent/40 text-accent-ink">{i + 1 < d.steps.length ? t("Yes → step {n}", { n: i + 2 }) : t("Yes → end")}</span>
                <span className="pill border-warn/40 text-warn">{nodes[i].no === "exit" ? t("No → exit") : t("No → step {n}", { n: String(nodes[i].no) })}</span>
              </p>
            )}
          </div>
        </li>
      ))}
      <li>{line}<div className="rounded-lg border border-dashed border-line px-3 py-2 text-center text-ink-3">{t("End")}</div></li>
    </ol>
  );
}
