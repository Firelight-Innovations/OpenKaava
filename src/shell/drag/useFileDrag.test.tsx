// @vitest-environment jsdom
/**
 * Where an operating-system file drop goes when it is not over a terminal: to the File
 * Explorer frame under the cursor, through the tool-window bridge. A drop over a terminal
 * stays the terminal's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const hit = vi.hoisted(() => ({ terminal: null as string | null }));
const captured = vi.hoisted(() => ({
  cb: null as null | ((drag: unknown) => void),
}));
const insertPaths = vi.hoisted(() => vi.fn());

vi.mock("../../bindings", () => ({
  onFileDrag: (cb: (drag: unknown) => void) => {
    captured.cb = cb;
    return Promise.resolve(() => {});
  },
}));
vi.mock("../dropZones", () => ({ terminalAt: () => hit.terminal }));
vi.mock("../state/terminals", () => ({ terminalTransport: { insertPaths } }));
vi.mock("../state/shellState", () => ({ windowLabel: () => "w" }));

import { registerToolWindow, unregisterToolWindow } from "../toolWindowRegistry";
import { useFileDrag } from "./useFileDrag";

const routeOsFileDrag = vi.fn();

beforeEach(() => {
  hit.terminal = null;
  captured.cb = null;
  insertPaths.mockReset();
  routeOsFileDrag.mockReset();
  registerToolWindow("w", { sendEventWhenReady: vi.fn(), routeOsFileDrag });
});
afterEach(() => {
  cleanup();
  unregisterToolWindow("w");
});

async function mount() {
  renderHook(() => useFileDrag());
  await waitFor(() => expect(captured.cb).not.toBeNull());
}

describe("an OS file drop outside a terminal", () => {
  it("is handed to the File Explorer under the cursor", async () => {
    routeOsFileDrag.mockReturnValue(true);
    await mount();
    captured.cb?.({ kind: "drop", x: 10, y: 20, paths: ["C:/a.txt"] });
    expect(routeOsFileDrag).toHaveBeenCalledWith({
      phase: "drop",
      x: 10,
      y: 20,
      paths: ["C:/a.txt"],
    });
    expect(insertPaths).not.toHaveBeenCalled();
  });

  it("tells the explorer where the drag is while it moves, and when it leaves", async () => {
    routeOsFileDrag.mockReturnValue(true);
    await mount();
    captured.cb?.({ kind: "over", x: 3, y: 4 });
    expect(routeOsFileDrag).toHaveBeenLastCalledWith({ phase: "over", x: 3, y: 4 });
    captured.cb?.({ kind: "leave" });
    expect(routeOsFileDrag).toHaveBeenLastCalledWith({ phase: "leave" });
  });

  it("stays the terminal's when the cursor is over one", async () => {
    hit.terminal = "term-1";
    await mount();
    captured.cb?.({ kind: "drop", x: 1, y: 1, paths: ["C:/a.txt"] });
    expect(insertPaths).toHaveBeenCalledWith("term-1", ["C:/a.txt"]);
    expect(routeOsFileDrag).not.toHaveBeenCalledWith(expect.objectContaining({ phase: "drop" }));
  });
});
