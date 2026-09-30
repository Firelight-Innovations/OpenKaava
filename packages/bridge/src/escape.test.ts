import { describe, expect, it, vi } from "vitest";
import { installEscapeForwarder, shouldForwardEscape } from "./escape";

const key = (over: Partial<Parameters<typeof shouldForwardEscape>[0]> = {}) => ({
  key: "Escape",
  defaultPrevented: false,
  target: { tagName: "DIV" },
  ...over,
});

describe("shouldForwardEscape", () => {
  it("forwards a bare Escape", () => {
    expect(shouldForwardEscape(key())).toBe(true);
  });
  it("ignores other keys", () => {
    expect(shouldForwardEscape(key({ key: "Enter" }))).toBe(false);
  });
  it("leaves Escape to the app when it already handled it", () => {
    expect(shouldForwardEscape(key({ defaultPrevented: true }))).toBe(false);
  });
  it("leaves Escape to a text field", () => {
    expect(shouldForwardEscape(key({ target: { tagName: "INPUT" } }))).toBe(false);
    expect(shouldForwardEscape(key({ target: { tagName: "TEXTAREA" } }))).toBe(false);
    expect(shouldForwardEscape(key({ target: { tagName: "DIV", isContentEditable: true } }))).toBe(
      false,
    );
  });
});

describe("installEscapeForwarder", () => {
  it("sends once per forwarded Escape and stops after removal", () => {
    let handler: ((e: never) => void) | null = null;
    const target = {
      addEventListener: (_t: "keydown", cb: (e: never) => void) => (handler = cb),
      removeEventListener: () => (handler = null),
    };
    const send = vi.fn();
    const remove = installEscapeForwarder(target as never, send);
    handler!(key() as never);
    handler!(key({ key: "a" }) as never);
    expect(send).toHaveBeenCalledTimes(1);
    remove();
    expect(handler).toBeNull();
  });
});
