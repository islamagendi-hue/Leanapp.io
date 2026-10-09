import { Fragment, type ReactNode } from "react";
import { msg, type T } from "@/i18n/translate";

/**
 * Fills `{name}` placeholders in an already translated sentence with React
 * nodes (links, code, bold), so a sentence with markup still translates whole.
 * Call t() without params so the placeholders survive, then pass a node per placeholder.
 */
export function rich(text: string, nodes: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const key = part.match(/^\{(\w+)\}$/)?.[1];
    return <Fragment key={i}>{key && key in nodes ? nodes[key] : part}</Fragment>;
  });
}

const ENV_NAMES: Record<string, string> = { development: msg("development"), staging: msg("staging"), production: msg("production") };

/** An environment type as it reads inside a sentence ("production" in English). */
export const envName = (t: T, env: string) => t(ENV_NAMES[env] ?? env);

const STATUS_NAMES: Record<string, string> = {
  active: msg("active"),
  paused: msg("paused"),
  pending: msg("pending"),
  succeeded: msg("succeeded"),
  failed: msg("failed"),
  giving_up: msg("giving_up"),
  skipped: msg("skipped"),
};

/** A link, postback or delivery status as stored ("paused"), in the reader's language. */
export const statusName = (t: T, status: string) => t(STATUS_NAMES[status] ?? status);
