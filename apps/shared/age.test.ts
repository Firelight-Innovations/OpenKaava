import { describe, expect, it } from "vitest";
import { formatRenderAge } from "./age";

describe("formatRenderAge", () => {
  const now = 1_700_000_000_000;

  it("reads as no render yet when nothing has rendered", () => {
    expect(formatRenderAge(null, now)).toBe("no render yet");
  });

  it("reads as just now under five seconds", () => {
    expect(formatRenderAge(now - 2_000, now)).toBe("rendered just now");
  });

  it("counts seconds under a minute", () => {
    expect(formatRenderAge(now - 40_000, now)).toBe("rendered 40s ago");
  });

  it("counts minutes under an hour", () => {
    expect(formatRenderAge(now - 5 * 60_000, now)).toBe("rendered 5m ago");
  });

  it("counts hours under a day", () => {
    expect(formatRenderAge(now - 3 * 3_600_000, now)).toBe("rendered 3h ago");
  });

  it("counts days past a day", () => {
    expect(formatRenderAge(now - 2 * 86_400_000, now)).toBe("rendered 2d ago");
  });

  it("clamps a render timestamp in the future to just now rather than a negative age", () => {
    expect(formatRenderAge(now + 10_000, now)).toBe("rendered just now");
  });
});
