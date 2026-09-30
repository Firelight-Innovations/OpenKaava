import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce } from "./debounce";

describe("debounce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs once, with the last arguments, after the quiet period", () => {
    const fn = vi.fn();
    const d = debounce(fn, 120);
    d(1);
    vi.advanceTimersByTime(100);
    d(2);
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(2);
  });

  it("collapses a 60 Hz burst into one call", () => {
    const fn = vi.fn();
    const d = debounce(fn, 120);
    for (let i = 0; i < 120; i++) {
      d(i);
      vi.advanceTimersByTime(16);
    }
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(119);
  });

  it("cancel drops the pending call", () => {
    const fn = vi.fn();
    const d = debounce(fn, 50);
    d();
    expect(d.pending()).toBe(true);
    d.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
    expect(d.pending()).toBe(false);
  });

  it("flush runs the pending call now, once, and is a no-op when idle", () => {
    const fn = vi.fn();
    const d = debounce(fn, 50);
    d.flush();
    expect(fn).not.toHaveBeenCalled();
    d("x");
    d.flush();
    expect(fn).toHaveBeenCalledWith("x");
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
