// @vitest-environment jsdom
/**
 * The hang the overnight QA found: a search whose backend call never came back
 * left the dialog on "Searching…" forever. Whatever the backend does — answers,
 * answers empty, fails, or never answers — the session has to reach a state
 * the dialog can draw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const searchContent = vi.fn();
vi.mock("../../bindings", () => ({ searchContent: (...a: unknown[]) => searchContent(...a) }));

import { useSearchSession } from "./useSearchSession";
import { SEARCH_TIMEOUT_MS } from "./searchSource";

beforeEach(() => {
  vi.useFakeTimers();
  searchContent.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function typeStack(
  hook: ReturnType<typeof renderHook<ReturnType<typeof useSearchSession>, unknown>>,
) {
  act(() => hook.result.current.setQuery("stack"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}

describe("useSearchSession", () => {
  it("resolves to results when the backend replies", async () => {
    searchContent.mockResolvedValue({
      hits: [{ path: "/p/src/a.ts", matches: [] }],
      truncated: true,
    });
    const hook = renderHook(() => useSearchSession("/p", "c1"));
    await typeStack(hook);

    expect(hook.result.current.searching).toBe(false);
    expect(hook.result.current.hits).toHaveLength(1);
    expect(hook.result.current.truncated).toBe(true);
    expect(hook.result.current.error).toBeNull();
  });

  it("resolves to an empty state when the backend replies with nothing", async () => {
    searchContent.mockResolvedValue({ hits: [], truncated: false });
    const hook = renderHook(() => useSearchSession("/p", "c1"));
    await typeStack(hook);

    expect(hook.result.current.searching).toBe(false);
    expect(hook.result.current.hits).toEqual([]);
    expect(hook.result.current.error).toBeNull();
  });

  it("surfaces a backend failure as an error and reports it to the console", async () => {
    searchContent.mockRejectedValue("the search did not complete: boom");
    const hook = renderHook(() => useSearchSession("/p", "c1"));
    await typeStack(hook);

    expect(hook.result.current.searching).toBe(false);
    expect(hook.result.current.error).toBe("the search did not complete: boom");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("gives up with an explicit error when the backend never answers", async () => {
    searchContent.mockReturnValue(new Promise(() => undefined));
    const hook = renderHook(() => useSearchSession("/p", "c1"));
    await typeStack(hook);
    expect(hook.result.current.searching).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_TIMEOUT_MS + 100);
    });

    expect(hook.result.current.searching).toBe(false);
    expect(hook.result.current.error).toMatch(/did not answer/);
    expect(console.error).toHaveBeenCalled();
  });
});
