import type { AnswerValue, Option, QuestionType } from "@/modules/implementation/questions";

export interface SerializedQuestion {
  key: string;
  type: QuestionType;
  prompt: string;
  help?: string;
  required: boolean;
  options: Option[];
  allowOther: boolean;
  placeholder?: string;
  value: AnswerValue | undefined;
  error?: string;
}

export function QuestionField({ q }: { q: SerializedQuestion }) {
  const id = q.key.replace(/\./g, "-");
  const v = q.value;
  const optionValues = new Set(q.options.map((o) => o.value));
  const other = q.type === "single" && typeof v === "string" && v && !optionValues.has(v) ? v : "";
  return (
    <fieldset className="space-y-2">
      <input type="hidden" name={`${q.key}__shown`} value="1" />
      <legend className="text-[15px] font-medium">
        {q.prompt} {!q.required && <span className="font-normal text-ink-3">(optional)</span>}
      </legend>
      {q.help && <p className="help -mt-1">{q.help}</p>}
      {q.type === "text" && <input className="input" id={id} name={q.key} defaultValue={typeof v === "string" ? v : ""} placeholder={q.placeholder} required={q.required} />}
      {q.type === "longtext" && (
        <textarea className="input min-h-24 py-2" id={id} name={q.key} defaultValue={typeof v === "string" ? v : ""} placeholder={q.placeholder} required={q.required} rows={3} />
      )}
      {q.type === "boolean" && (
        <div className="flex gap-2">
          {[["true", "Yes"], ["false", "No"]].map(([val, label]) => (
            <label key={val} className="flex min-h-10 items-center gap-2 rounded-lg border border-line px-4 text-sm has-checked:border-accent has-checked:bg-accent-soft">
              <input type="radio" name={q.key} value={val} defaultChecked={String(v) === val} required={q.required} />
              {label}
            </label>
          ))}
        </div>
      )}
      {(q.type === "single" || q.type === "multi") && (
        <div className="grid gap-2 sm:grid-cols-2">
          {q.options.map((o) => (
            <label key={o.value} className="flex min-h-10 items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm has-checked:border-accent has-checked:bg-accent-soft">
              <input
                type={q.type === "single" ? "radio" : "checkbox"}
                name={q.key}
                value={o.value}
                defaultChecked={Array.isArray(v) ? v.includes(o.value) : v === o.value}
              />
              {o.label}
            </label>
          ))}
          {q.allowOther && (
            <label className="flex min-h-10 items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm has-checked:border-accent sm:col-span-2">
              <input type="radio" name={q.key} value="__other" defaultChecked={!!other} />
              <span className="shrink-0">Other event:</span>
              <input className="input min-h-8" name={`${q.key}__other`} defaultValue={other} placeholder="first_address_saved" pattern="[a-z][a-z0-9_]{1,63}" />
            </label>
          )}
        </div>
      )}
      {q.error && <p className="text-sm text-alert">{q.error}</p>}
    </fieldset>
  );
}
