import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HARNESS_REFRESH_MS,
  requestHarnessRefresh,
  resetHarnessRefresh,
  subscribeHarnessRefresh,
} from "./harnessRefresh";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetHarnessRefresh();
});

afterEach(() => {
  resetHarnessRefresh();
  vi.useRealTimers();
});

describe("harness refresh throttle", () => {
  it("runs detection at once for the first request", () => {
    const run = vi.fn();
    subscribeHarnessRefresh("t1", run);
    requestHarnessRefresh("t1");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst inside the window into one trailing run", () => {
    const run = vi.fn();
    subscribeHarnessRefresh("t1", run);
    requestHarnessRefresh("t1");
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(50);
      requestHarnessRefresh("t1");
    }
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HARNESS_REFRESH_MS);
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(HARNESS_REFRESH_MS * 5);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("never runs on its own: no request, no detection", () => {
    const run = vi.fn();
    subscribeHarnessRefresh("t1", run);
    vi.advanceTimersByTime(HARNESS_REFRESH_MS * 10);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs again immediately once the window has passed", () => {
    const run = vi.fn();
    subscribeHarnessRefresh("t1", run);
    requestHarnessRefresh("t1");
    vi.advanceTimersByTime(HARNESS_REFRESH_MS + 1);
    requestHarnessRefresh("t1");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("throttles each session on its own", () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeHarnessRefresh("a", a);
    subscribeHarnessRefresh("b", b);
    requestHarnessRefresh("a");
    requestHarnessRefresh("b");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("stops calling an unsubscribed listener", () => {
    const run = vi.fn();
    const off = subscribeHarnessRefresh("t1", run);
    off();
    requestHarnessRefresh("t1");
    expect(run).not.toHaveBeenCalled();
  });
});
