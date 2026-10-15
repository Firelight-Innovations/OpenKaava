import { describe, expect, it } from "vitest";
import { railKeyOf } from "./railKey";

const press = (
  key: string,
  mods: Partial<Record<"ctrlKey" | "metaKey" | "shiftKey", boolean>> = {},
) => railKeyOf({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, key, ...mods });

describe("railKeyOf", () => {
  it("reads Alt+1 to Alt+7, the last of them the seventh page", () => {
    expect(press("1")).toBe(1);
    expect(press("7")).toBe(7);
    expect(press("8")).toBeNull();
    expect(press("0")).toBeNull();
    expect(press("a")).toBeNull();
  });

  it("leaves a digit with another modifier, or without Alt, alone", () => {
    expect(press("7", { ctrlKey: true })).toBeNull();
    expect(press("7", { shiftKey: true })).toBeNull();
    expect(press("7", { metaKey: true })).toBeNull();
    expect(
      railKeyOf({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: "7" }),
    ).toBeNull();
  });
});
