import { describe, expect, it } from "vitest";
import { latestUsage, shareOf, toneOf } from "./meters";
import type { Item } from "./protocol.generated";
import { strings } from "./strings";

const usage = (id: string, used: number, size: number): Item => ({
  id,
  turnId: "t1",
  kind: { kind: "usage", used, size },
});

describe("meters", () => {
  it("turns a meter yellow from 80% and red from 95%", () => {
    expect(toneOf(0.45)).toBe("low");
    expect(toneOf(0.79)).toBe("low");
    expect(toneOf(0.8)).toBe("high");
    expect(toneOf(0.94)).toBe("high");
    expect(toneOf(0.95)).toBe("full");
  });

  it("clamps a share, and reads nothing to divide by as empty", () => {
    expect(shareOf(150, 100)).toBe(1);
    expect(shareOf(5, 0)).toBe(0);
  });

  it("takes the latest usage report, and nulls before one arrives", () => {
    const text: Item = { id: "a", turnId: "t1", kind: { kind: "assistantText", text: "hi" } };
    expect(latestUsage([text])).toEqual({ used: null, size: null });
    expect(latestUsage([usage("1", 10, 100), text, usage("2", 20, 100), text])).toEqual({
      used: 20,
      size: 100,
    });
  });

  it("writes token counts short", () => {
    expect(strings.tokens(812)).toBe("812");
    expect(strings.tokens(124_600)).toBe("124.6k");
    expect(strings.tokens(300_000)).toBe("300k");
    expect(strings.tokens(1_200_000)).toBe("1.2M");
    // Rounded first, then given a unit: never "1000k".
    expect(strings.tokens(999_960)).toBe("1M");
    expect(strings.context.summary(124_600, 300_000)).toBe("124.6k / 300k (42%)");
    // Past full (while the agent compacts) it says 100%, as the meter does.
    expect(strings.context.summary(210_000, 200_000)).toBe("210k / 200k (100%)");
  });
});
