"use client";

import { useState, useTransition } from "react";
import { ActionForm, type FormState } from "@/components/ActionForm";
import { useT } from "@/i18n/client";
import { ConditionBuilder, type Json, type PropertyLists } from "./ConditionBuilder";

type Node = Json & { type: string };

export function AudienceEditor({
  save, preview, initial, events, properties,
}: {
  save: (state: FormState, form: FormData) => Promise<FormState>;
  preview: (definitionJson: string) => Promise<{ size?: number; sample?: string[]; description?: string; error?: string }>;
  initial: { name: string; description: string; refreshMinutes: number; definition: Node };
  events: string[];
  properties?: PropertyLists;
}) {
  const [definition, setDefinition] = useState<Node>(initial.definition.type === "and" || initial.definition.type === "or" ? initial.definition : { type: "and", children: [initial.definition] });
  const [result, setResult] = useState<Awaited<ReturnType<typeof preview>> | null>(null);
  const [pending, start] = useTransition();
  const json = JSON.stringify(definition);
  const t = useT();

  return (
    <ActionForm action={save} submitLabel={t("Save audience")} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-[2fr_3fr_1fr]">
        <label className="block"><span className="label">{t("Name")}</span><input name="name" className="input" defaultValue={initial.name} required maxLength={80} /></label>
        <label className="block"><span className="label">{t("Description")}</span><input name="description" className="input" defaultValue={initial.description} maxLength={500} /></label>
        <label className="block"><span className="label">{t("Recompute every")}</span>
          <select name="refreshMinutes" className="input" defaultValue={String(initial.refreshMinutes)}>
            {[5, 15, 60, 360, 1440].map((m) => <option key={m} value={m}>{m < 60 ? t("{n} min", { n: m }) : m === 60 ? t("hour") : m === 1440 ? t("day") : t("{n} hours", { n: m / 60 })}</option>)}
          </select>
        </label>
      </div>
      <input type="hidden" name="definition" value={json} />
      <ConditionBuilder value={definition} onChange={setDefinition} events={events} properties={properties} />
      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-paper-2 px-3 py-2 text-sm">
        <button type="button" className="btn-secondary min-h-9" disabled={pending} onClick={() => start(async () => setResult(await preview(json)))}>
          {pending ? t("Counting…") : t("Preview size")}
        </button>
        {result?.error && <span className="text-alert">{t(result.error)}</span>}
        {result && !result.error && (
          <span>
            {t("{n} people match right now", { n: result.size?.toLocaleString("en-US") ?? "" })}
            {result.sample?.length ? <span className="text-ink-3"> · {t("e.g.")} <span className="font-mono text-xs" dir="ltr">{result.sample.slice(0, 5).join(", ")}</span></span> : null}
          </span>
        )}
      </div>
    </ActionForm>
  );
}
