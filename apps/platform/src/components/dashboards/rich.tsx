import { Fragment, type ReactNode } from "react";

/**
 * A translated sentence with elements in it: each `{name}` left in the text
 * (translate it without params) is replaced by `parts[name]`, e.g. a link.
 */
export function rich(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((s, i) => {
    const k = /^\{(\w+)\}$/.exec(s)?.[1];
    return k && k in parts ? <Fragment key={i}>{parts[k]}</Fragment> : s;
  });
}
