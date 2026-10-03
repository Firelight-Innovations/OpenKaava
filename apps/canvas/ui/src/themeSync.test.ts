import { describe, expect, it } from "vitest";
import { themeNeedsPush } from "./themeSync";

describe("themeNeedsPush", () => {
  it("pushes when Excalidraw kept dark inside a light shell", () => {
    expect(themeNeedsPush("dark", "light")).toBe(true);
    expect(themeNeedsPush("light", "dark")).toBe(true);
  });
  it("does nothing when they agree or the theme is not reported", () => {
    expect(themeNeedsPush("light", "light")).toBe(false);
    expect(themeNeedsPush(undefined, "light")).toBe(false);
  });
});
