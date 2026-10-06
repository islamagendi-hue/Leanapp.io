import "server-only";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/log";

export interface ActionState {
  error?: string;
  fieldErrors?: Record<string, string>;
  ok?: boolean;
  /** Shown once (e.g. a newly created secret key or invite link). */
  secret?: string;
  message?: string;
}

/** Maps domain errors to form state; unexpected errors are logged and hidden. */
export function toActionError(err: unknown): ActionState {
  if (err instanceof AppError) {
    const details = err.details as Record<string, string[] | string> | undefined;
    const fieldErrors = details && typeof details === "object"
      ? Object.fromEntries(Object.entries(details).map(([k, v]) => [k, Array.isArray(v) ? v[0] : String(v)]))
      : undefined;
    return { error: err.message, fieldErrors };
  }
  // Next.js uses thrown errors for redirect()/notFound(); let them through.
  if (err && typeof err === "object" && "digest" in err) throw err;
  log.error("action.failed", { error: err });
  return { error: "Something went wrong. Please try again." };
}
