// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import SettingRow from "./SettingRow";
import type { Setting, SettingValue } from "../../bindings";
import type { SettingsSession } from "./useSettings";

const THEME = {
  key: "appearance.theme",
  title: "Theme",
  description: "Dark is the default.",
  control: {
    kind: "select",
    default: "dark",
    options: [
      { value: "dark", label: "Dark", description: "" },
      { value: "light", label: "Light", description: "" },
      { value: "system", label: "System", description: "" },
    ],
  },
  applies: { when: "now" },
} as unknown as Setting;

const ACCENT = {
  key: "appearance.accentColor",
  title: "Accent colour",
  description: "",
  control: {
    kind: "select",
    default: "blue",
    options: [
      { value: "blue", label: "Blue", description: "" },
      { value: "amber", label: "Amber", description: "" },
    ],
  },
  applies: { when: "now" },
} as unknown as Setting;

function session(values: Record<string, SettingValue>, changed: string[] = []) {
  const set = vi.fn();
  const reset = vi.fn();
  const fake = {
    groups: [],
    valueOf: (setting: Setting) =>
      values[setting.key] ?? (setting.control as { default: SettingValue }).default,
    isChanged: (key: string) => changed.includes(key),
    changedIn: () => 0,
    set,
    reset,
    resetGroup: vi.fn(),
    error: null,
    ready: true,
  } as unknown as SettingsSession;
  return { fake, set, reset };
}

afterEach(cleanup);

describe("SettingRow", () => {
  it("draws Theme as a segmented control and writes the picked option", () => {
    const { fake, set } = session({});
    render(<SettingRow setting={THEME} session={fake} />);
    expect(screen.getByRole("radiogroup", { name: "Theme" }).className).toContain(
      "k-tabs--segmented",
    );
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(set).toHaveBeenCalledWith(THEME, "light");
  });

  it("draws the accent as a row of named swatches", () => {
    const { fake, set } = session({ "appearance.accentColor": "amber" });
    render(<SettingRow setting={ACCENT} session={fake} />);
    const amber = screen.getByRole("radio", { name: "Amber" });
    expect(amber.getAttribute("aria-checked")).toBe("true");
    expect(amber.getAttribute("title")).toContain("Amber");
    expect(amber.style.background).toBe("var(--accent-amber)");
    fireEvent.click(screen.getByRole("radio", { name: "Blue" }));
    expect(set).toHaveBeenCalledWith(ACCENT, "blue");
  });

  it("marks a modified row and offers a reset in the reserved slot", () => {
    const { fake, reset } = session({ "appearance.theme": "light" }, ["appearance.theme"]);
    render(<SettingRow setting={THEME} session={fake} />);
    expect(screen.getByRole("img", { name: "Modified" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset Theme to its default" }));
    expect(reset).toHaveBeenCalledWith(THEME);
  });

  it("shows neither the marker nor a reset when the value is the default", () => {
    const { fake } = session({});
    render(<SettingRow setting={THEME} session={fake} />);
    expect(screen.queryByRole("img", { name: "Modified" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reset/ })).toBeNull();
  });
});
