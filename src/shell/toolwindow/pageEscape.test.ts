// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { relayPageEscape } from "./pageEscape";

const heard = vi.fn();
afterEach(() => document.removeEventListener("keydown", heard));

describe("relayPageEscape", () => {
  it("replays Escape on the shell document for the rail page's frame", () => {
    document.addEventListener("keydown", heard);
    expect(relayPageEscape("inst-1", "inst-1", document)).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    expect((heard.mock.calls[0]![0] as KeyboardEvent).key).toBe("Escape");
  });

  it("ignores a frame that is not the page", () => {
    heard.mockClear();
    document.addEventListener("keydown", heard);
    expect(relayPageEscape("pane-frame", "inst-1", document)).toBe(false);
    expect(relayPageEscape("inst-1", null, document)).toBe(false);
    expect(heard).not.toHaveBeenCalled();
  });
});
