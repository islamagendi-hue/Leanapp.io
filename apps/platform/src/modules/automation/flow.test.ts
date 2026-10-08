import { describe, expect, it } from "vitest";
import { flowNodes, insertStep, moveStep, removeStep, type FlowStep } from "./flow";

// 0 branch (no → 3), 1 push A, 2 exit, 3 push B
const flow: FlowStep[] = [
  { type: "branch", else: { goto: 3 } },
  { type: "push", title: "A" },
  { type: "exit" },
  { type: "push", title: "B" },
];
const jumps = (steps: FlowStep[]) => steps.filter((s) => s.type === "branch").map((s) => s.else);

describe("flow editing keeps branches pointing at the same step", () => {
  it("inserts", () => {
    const after = insertStep(flow, 1, { type: "delay" });
    expect(jumps(after)).toEqual([{ goto: 4 }]);
    expect(after[4]).toMatchObject({ title: "B" });
    expect(jumps(insertStep(flow, 4, { type: "delay" }))).toEqual([{ goto: 3 }]);
  });

  it("removes", () => {
    expect(jumps(removeStep(flow, 1))).toEqual([{ goto: 2 }]);
    // Removing the target lands on the next step, or exits when there is none.
    expect(jumps(removeStep(flow, 3))).toEqual(["exit"]);
    expect(jumps(removeStep([...flow, { type: "delay" }], 3))).toEqual([{ goto: 3 }]);
  });

  it("moves", () => {
    const after = moveStep(flow, 3, 1); // B moves up
    expect(after.map((s) => s.title ?? s.type)).toEqual(["branch", "B", "A", "exit"]);
    expect(jumps(after)).toEqual([{ goto: 1 }]);
  });

  it("describes the nodes, flagging jumps that no longer point forward", () => {
    expect(flowNodes(flow)).toEqual([{ index: 0, type: "branch", no: 4, broken: false }, { index: 1, type: "push" }, { index: 2, type: "exit" }, { index: 3, type: "push" }]);
    expect(flowNodes(moveStep(flow, 0, 3))[3]).toMatchObject({ type: "branch", broken: true });
  });
});
