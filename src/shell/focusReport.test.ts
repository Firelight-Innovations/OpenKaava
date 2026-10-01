// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FOCUS_DEBOUNCE_MS,
  createFocusReporter,
  readFocus,
  sameFocus,
  type FocusContext,
  type FocusReport,
} from "./focusReport";

const context: FocusContext = { window: "main", cluster: "cluster-1", pane: "pane-1" };

function report(over: Partial<FocusReport> = {}): FocusReport {
  return {
    window: "main",
    windowHasFocus: true,
    focusIn: "app",
    instance: "canvas-1",
    pane: "pane-1",
    cluster: "cluster-1",
    ...over,
  };
}

describe("readFocus", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("says nothing when nothing is focused", () => {
    const read = readFocus(document, context);
    expect(read.focusIn).toBe("nothing");
    expect(read.instance).toBeNull();
    expect(read.pane).toBe("pane-1");
    expect(read.cluster).toBe("cluster-1");
  });

  it("resolves a focused app frame to its instance", () => {
    document.body.innerHTML = `<div data-instance="canvas-2"><iframe></iframe></div>`;
    document.querySelector("iframe")?.focus();
    const read = readFocus(document, context);
    expect(read.focusIn).toBe("app");
    expect(read.instance).toBe("canvas-2");
  });

  it("recognises a terminal by its emulator", () => {
    document.body.innerHTML = `<div data-instance="term-1"><div class="xterm"><textarea></textarea></div></div>`;
    document.querySelector("textarea")?.focus();
    const read = readFocus(document, context);
    expect(read.focusIn).toBe("terminal");
    expect(read.instance).toBe("term-1");
  });

  it("calls any other focused element the shell", () => {
    document.body.innerHTML = `<input />`;
    document.querySelector("input")?.focus();
    const read = readFocus(document, context);
    expect(read.focusIn).toBe("shell");
    expect(read.instance).toBeNull();
  });
});

describe("sameFocus", () => {
  it("compares every field", () => {
    expect(sameFocus(report(), report())).toBe(true);
    expect(sameFocus(report(), report({ instance: "canvas-2" }))).toBe(false);
    expect(sameFocus(report(), report({ pane: "pane-2" }))).toBe(false);
    expect(sameFocus(report(), report({ cluster: "cluster-2" }))).toBe(false);
    expect(sameFocus(report(), report({ windowHasFocus: false }))).toBe(false);
  });
});

describe("createFocusReporter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends nothing until focus has been quiet for the delay", () => {
    const send = vi.fn();
    const reporter = createFocusReporter(() => report(), send);

    reporter.schedule();
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS - 1);
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("folds a burst of events into one report of where focus ended up", () => {
    const send = vi.fn();
    let current = report({ instance: "canvas-1" });
    const reporter = createFocusReporter(() => current, send);

    reporter.schedule();
    vi.advanceTimersByTime(100);
    current = report({ instance: "canvas-2" });
    reporter.schedule();
    vi.advanceTimersByTime(100);
    current = report({ instance: "canvas-3" });
    reporter.schedule();
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(report({ instance: "canvas-3" }));
  });

  it("sends nothing when focus has not really changed", () => {
    const send = vi.fn();
    const reporter = createFocusReporter(() => report(), send);

    reporter.schedule();
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS);
    reporter.schedule();
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS);
    reporter.schedule();
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when focus leaves and returns within the delay", () => {
    const send = vi.fn();
    let current = report();
    const reporter = createFocusReporter(() => current, send);
    reporter.schedule();
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS);
    send.mockClear();

    current = report({ instance: null, focusIn: "nothing" });
    reporter.schedule();
    vi.advanceTimersByTime(50);
    current = report();
    reporter.schedule();
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS);

    expect(send).not.toHaveBeenCalled();
  });

  it("sends again when focus moves after a quiet spell", () => {
    const send = vi.fn();
    let current = report();
    const reporter = createFocusReporter(() => current, send);
    reporter.schedule();
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS);

    current = report({ pane: "pane-2" });
    reporter.schedule();
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends nothing once disposed", () => {
    const send = vi.fn();
    const reporter = createFocusReporter(() => report(), send);
    reporter.schedule();
    reporter.dispose();
    vi.advanceTimersByTime(FOCUS_DEBOUNCE_MS * 2);
    expect(send).not.toHaveBeenCalled();
  });
});
