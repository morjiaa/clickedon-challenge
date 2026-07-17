import { describe, it, expect } from "vitest";
import { generate } from "../lib/pipeline";

// Bonus edge case (my own test — the gate file is left untouched).
//
// The gate tests cover the two extremes of the revision loop: review passes on
// the first look, or review never passes. The interesting boundary is in
// between — review passes AFTER a few revisions but still within budget. This
// guards against an off-by-one that would either error out a draft that should
// have passed, or over-count attempts.
describe("Edge — review that passes mid-loop succeeds with the right attempt count", () => {
  it("revises until review passes on attempt 2, then hands off successfully", async () => {
    let handedOff = false;
    const res = await generate({
      behavior: "ok",
      advanceToNextStage: async () => {
        handedOff = true;
      },
      // Fails on attempts 0 and 1, passes on attempt 2 — inside MAX_REVISIONS.
      reviewPasses: (attempt) => attempt >= 2,
    });

    expect(res.status).toBe("ok");
    expect(res.attempts).toBe(2);
    expect(handedOff).toBe(true);
  });
});
