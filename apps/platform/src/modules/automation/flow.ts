/**
 * Editing a flow's step list without breaking its branches. A branch's "no"
 * path jumps forward to a step index; inserting, removing or moving steps
 * renumbers those jumps so they keep pointing at the same step. Pure and
 * client-safe (used by the flow builder).
 */

type Jump = "exit" | { goto: number };
export type FlowStep = { type: string; else?: Jump | unknown; [k: string]: unknown };

const isGoto = (j: unknown): j is { goto: number } => typeof j === "object" && j !== null && typeof (j as { goto?: unknown }).goto === "number";

function remap<S extends FlowStep>(steps: S[], map: (target: number) => number | "exit"): S[] {
  return steps.map((s) => {
    if (s.type !== "branch" || !isGoto(s.else)) return s;
    const to = map(s.else.goto);
    return { ...s, else: to === "exit" ? "exit" : { goto: to } };
  });
}

/** Inserts `step` at index `at` (0 = first). Jumps to steps at or after `at` shift by one. */
export function insertStep<S extends FlowStep>(steps: S[], at: number, step: S): S[] {
  const shifted = remap(steps, (t) => (t >= at ? t + 1 : t));
  return [...shifted.slice(0, at), step, ...shifted.slice(at)];
}

/** Removes the step at `at`. A jump to it now lands on the step that took its place, or exits if none. */
export function removeStep<S extends FlowStep>(steps: S[], at: number): S[] {
  const rest = steps.filter((_, i) => i !== at);
  return remap(rest, (t) => (t > at ? t - 1 : t === at ? (at < rest.length ? at : "exit") : t));
}

/** Moves the step at `from` to index `to`. Jumps follow the steps they pointed at. */
export function moveStep<S extends FlowStep>(steps: S[], from: number, to: number): S[] {
  const order = steps.map((_, i) => i);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  const newIndex = new Map(order.map((old, i) => [old, i]));
  return remap(order.map((old) => steps[old]), (t) => newIndex.get(t) ?? "exit");
}

export interface FlowNode {
  index: number;
  type: string;
  /** For branches: where "no" goes (a step number, 1-based, or "exit"). */
  no?: number | "exit";
  /** A jump that doesn't point forward any more (the flow won't save until it's fixed). */
  broken?: boolean;
}

/** The nodes of a flow for drawing it top to bottom. */
export function flowNodes(steps: FlowStep[]): FlowNode[] {
  return steps.map((s, i) => {
    if (s.type !== "branch") return { index: i, type: s.type };
    if (!isGoto(s.else)) return { index: i, type: s.type, no: "exit" };
    return { index: i, type: s.type, no: s.else.goto + 1, broken: s.else.goto <= i || s.else.goto >= steps.length };
  });
}
