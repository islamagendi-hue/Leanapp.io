import { describe, expect, it } from "vitest";
import { FLOW } from "./landing";

describe("landing content", () => {
  it("follows the product flow", () => {
    expect(FLOW.map((s) => s.step)).toEqual(["Connect", "Collect", "Understand", "Funnels", "Retention", "Audiences", "Act"]);
  });

  it("never labels as live what isn't", () => {
    const live = FLOW.flatMap((s) => s.items).filter((i) => i.state === "live").map((i) => i.name).join(" | ");
    expect(live).not.toMatch(/SDK|in-app|deep link|acquisition|attribution/i);
    for (const i of FLOW.flatMap((s) => s.items)) if (i.state === "beta") expect(i.note, i.name).toBeTruthy();
  });
});
