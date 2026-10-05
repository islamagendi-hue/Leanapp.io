"use client";

import { useActionState } from "react";

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
  ok?: boolean;
  secret?: string;
  message?: string;
}

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

/** A form bound to a server action, showing its error / one-time secret / success message. */
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel = "Working…",
  className = "space-y-4",
  buttonClass = "btn",
  confirm,
}: {
  action: Action;
  children?: React.ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  className?: string;
  buttonClass?: string;
  confirm?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      {state.fieldErrors && Object.keys(state.fieldErrors).length > 0 && (
        <ul className="space-y-1 text-sm text-alert" role="alert">
          {Object.entries(state.fieldErrors).map(([k, v]) => (
            <li key={k}>{v}</li>
          ))}
        </ul>
      )}
      {state.error && !state.fieldErrors && (
        <p className="rounded-lg bg-alert-soft px-3 py-2 text-sm text-alert" role="alert">{state.error}</p>
      )}
      {state.message && <p className="rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent-ink">{state.message}</p>}
      {state.secret && (
        <div className="rounded-lg border border-warn/40 bg-warn-soft p-3 text-sm">
          <p className="mb-2 font-medium">Copy this now. It won&apos;t be shown again.</p>
          <code className="block break-all rounded bg-white px-2 py-1 font-mono text-xs">{state.secret}</code>
        </div>
      )}
      <button type="submit" className={buttonClass} disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </button>
    </form>
  );
}
