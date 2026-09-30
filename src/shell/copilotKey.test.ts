// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  COPILOT_ACTIONS,
  DEFAULT_COPILOT_ACTION,
  dispatchCopilotKey,
  isCopilotKey,
  narrowCopilotAction,
  type CopilotHandlers,
} from "./copilotKey";

const ev = (key: string, ctrlKey = false, altKey = false) => ({ key, ctrlKey, altKey });

describe("isCopilotKey", () => {
  it("takes F23 however Win and Shift are reported", () => {
    expect(isCopilotKey(ev("F23"))).toBe(true);
    for (const shiftKey of [false, true]) {
      for (const metaKey of [false, true]) {
        const event = new KeyboardEvent("keydown", { key: "F23", shiftKey, metaKey });
        expect(isCopilotKey(event)).toBe(true);
      }
    }
  });

  it("leaves F23 chords that carry Ctrl or Alt alone", () => {
    expect(isCopilotKey(ev("F23", true))).toBe(false);
    expect(isCopilotKey(ev("F23", false, true))).toBe(false);
  });

  it("ignores every other key", () => {
    expect(isCopilotKey(ev("F22"))).toBe(false);
    expect(isCopilotKey(ev("p", true))).toBe(false);
  });
});

describe("narrowCopilotAction", () => {
  it("defaults to the Command Palette", () => {
    expect(DEFAULT_COPILOT_ACTION).toBe("palette");
    expect(narrowCopilotAction(null)).toBe("palette");
  });

  it("maps the removed side-panel action to the Git page", () => {
    expect(narrowCopilotAction("togglePanel")).toBe("toggleGit");
  });

  it("falls back on a value this build does not know", () => {
    expect(narrowCopilotAction("openCopilot")).toBe("palette");
    expect(narrowCopilotAction(3)).toBe("palette");
  });

  it("keeps every known id", () => {
    for (const id of COPILOT_ACTIONS) expect(narrowCopilotAction(id)).toBe(id);
  });
});

describe("dispatchCopilotKey", () => {
  function handlers(): CopilotHandlers {
    return {
      palette: vi.fn(),
      search: vi.fn(),
      switchProject: vi.fn(),
      newCluster: vi.fn(),
      toggleGit: vi.fn(),
      toggleTerminal: vi.fn(),
    };
  }

  it("runs the configured action and only that one", () => {
    for (const id of COPILOT_ACTIONS) {
      if (id === "none") continue;
      const h = handlers();
      expect(dispatchCopilotKey(id, h)).toBe(true);
      for (const [name, fn] of Object.entries(h)) {
        expect(fn).toHaveBeenCalledTimes(name === id ? 1 : 0);
      }
    }
  });

  it("does nothing, and reports the key untaken, for none", () => {
    const h = handlers();
    expect(dispatchCopilotKey("none", h)).toBe(false);
    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
  });
});
