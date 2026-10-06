"use client";

import { useState, useTransition } from "react";
import { ActionForm, type FormState } from "@/components/ActionForm";
import { ConditionBuilder, type Json } from "./ConditionBuilder";

type Node = Json & { type: string };

export function AudienceEditor({
  save, preview, initial, events,
}: {
  save: (state: FormState, form: FormData) => Promise<FormState>;
  preview: (definitionJson: string) => Promise<{ size?: number; sample?: string[]; description?: string; error?: string }>;
  initial: { name: string; description: string; refreshMinutes: number; definition: Node };
  events: string[];
}) {
  const [definition, setDefinition] = useState<Node>(initial.definition.type === "and" || initial.definition.type === "or" ? initial.definition : { type: "and", children: [initial.definition] });
  const [result, setResult] = useState<Awaited<ReturnType<typeof preview>> | null>(null);
  const [pending, start] = useTransition();
  const json = JSON.stringify(definition);

  return (
    <ActionForm action={save} submitLabel="Save audience" className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-[2fr_3fr_1fr]">
        <label className="block"><span className="label">Name</span><input name="name" className="input" defaultValue={initial.name} required maxLength={80} /></label>
        <label className="block"><span className="label">Description</span><input name="description" className="input" defaultValue={initial.description} maxLength={500} /></label>
        <label className="block"><span className="label">Recompute every</span>
          <select name="refreshMinutes" className="input" defaultValue={String(initial.refreshMinutes)}>
            {[5, 15, 60, 360, 1440].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : m === 60 ? "hour" : m === 1440 ? "day" : `${m / 60} hours`}</option>)}
          </select>
        </label>
      </div>
      <input type="hidden" name="definition" value={json} />
      <ConditionBuilder value={definition} onChange={setDefinition} events={events} />
      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-paper-2 px-3 py-2 text-sm">
        <button type="button" className="btn-secondary min-h-9" disabled={pending} onClick={() => start(async () => setResult(await preview(json)))}>
          {pending ? "Counting…" : "Preview size"}
        </button>
        {result?.error && <span className="text-alert">{result.error}</span>}
        {result && !result.error && (
          <span>
            <strong>{result.size?.toLocaleString("en-US")}</strong> people match right now
            {result.sample?.length ? <span className="text-ink-3"> · e.g. <span className="font-mono text-xs">{result.sample.slice(0, 5).join(", ")}</span></span> : null}
          </span>
        )}
      </div>
    </ActionForm>
  );
}
