import { describeStep, describeTrigger, type AutomationDefinition } from "@/modules/automation/definition";
import { flowNodes } from "@/modules/automation/flow";

const TONE: Record<string, string> = { delay: "border-s-ink-3", branch: "border-s-warn", exit: "border-s-alert", push: "border-s-accent", in_app: "border-s-accent", email: "border-s-accent", whatsapp: "border-s-accent" };

/** A flow drawn top to bottom: trigger, steps (branches with their yes / no paths), end. Read-only. */
export function FlowView({ definition: d, audienceName }: { definition: AutomationDefinition; audienceName: (id: string) => string }) {
  const nodes = flowNodes(d.steps);
  const line = <span className="mx-auto block h-4 w-px bg-line-strong" aria-hidden />;
  return (
    <ol className="max-w-2xl text-sm" aria-label="Flow">
      <li className="rounded-lg border border-line border-s-4 border-s-ink bg-card px-3 py-2"><span className="text-xs text-ink-3">Trigger</span><p>{describeTrigger(d.trigger, audienceName)}</p></li>
      {d.steps.map((s, i) => (
        <li key={i}>
          {line}
          <div className={`rounded-lg border border-line border-s-4 bg-card px-3 py-2 ${TONE[s.type] ?? "border-s-line-strong"}`}>
            <span className="text-xs text-ink-3">Step {i + 1}</span>
            <p>{describeStep(s)}</p>
            {s.type === "branch" && (
              <p className="mt-1 flex flex-wrap gap-2 text-xs">
                <span className="pill border-accent/40 text-accent-ink">Yes → {i + 1 < d.steps.length ? `step ${i + 2}` : "end"}</span>
                <span className="pill border-warn/40 text-warn">No → {nodes[i].no === "exit" ? "exit" : `step ${nodes[i].no}`}</span>
              </p>
            )}
          </div>
        </li>
      ))}
      <li>{line}<div className="rounded-lg border border-dashed border-line px-3 py-2 text-center text-ink-3">End</div></li>
    </ol>
  );
}
