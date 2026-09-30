import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Autosaver, type SaveState } from "./saver";
import type { SceneFile } from "./scene";

const scene = (n: number): SceneFile => ({
  type: "excalidraw",
  version: 2,
  elements: [{ id: `e${n}`, type: "rectangle" }],
  appState: {},
  files: {},
});

function make(write: (s: SceneFile, base: number | null) => Promise<number | null>) {
  const states: SaveState[] = [];
  const saver = new Autosaver({
    delay: 500,
    write,
    isStale: (e) => e instanceof Error && e.message === "stale",
    onState: (s) => states.push(s),
  });
  return { saver, states };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Autosaver", () => {
  it("waits for the last change before writing, and writes once", async () => {
    const write = vi.fn().mockResolvedValue(11);
    const { saver } = make(write);
    saver.setBase(10, "s0");
    saver.schedule(scene(1), "s1");
    await vi.advanceTimersByTimeAsync(400);
    saver.schedule(scene(2), "s2");
    await vi.advanceTimersByTimeAsync(400);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(scene(2), 10);
    expect(saver.mtime).toBe(11);
  });

  it("still writes when the same unsaved state is reported over and over", async () => {
    const write = vi.fn().mockResolvedValue(11);
    const { saver } = make(write);
    saver.setBase(10, "s0");
    for (let i = 0; i < 10; i++) {
      saver.schedule(scene(1), "s1");
      await vi.advanceTimersByTimeAsync(400);
    }
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not write again when the write's own re-render reports the same state", async () => {
    let saver!: Autosaver;
    const write = vi.fn(async () => {
      // The save-state change re-renders the editor, which reports its scene again.
      await Promise.resolve();
      saver.schedule(scene(1), "s1");
      return 11;
    });
    const made = make(write);
    saver = made.saver;
    saver.setBase(10, "s0");
    saver.schedule(scene(1), "s1");
    await vi.advanceTimersByTimeAsync(5000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(made.states[made.states.length - 1]).toBe("saved");
  });

  it("does not write a change that matches what is already saved", async () => {
    const write = vi.fn().mockResolvedValue(11);
    const { saver, states } = make(write);
    saver.setBase(10, "same");
    saver.schedule(scene(1), "same");
    await vi.advanceTimersByTimeAsync(2000);
    expect(write).not.toHaveBeenCalled();
    expect(states[states.length - 1]).toBe("saved");
  });

  it("writes a change made mid-save afterwards, from the mtime the first write returned", async () => {
    let release: (m: number) => void = () => {};
    const write = vi
      .fn()
      .mockImplementationOnce(() => new Promise<number>((r) => (release = r)))
      .mockResolvedValueOnce(30);
    const { saver } = make(write);
    saver.setBase(10, "s0");
    saver.schedule(scene(1), "s1");
    await vi.advanceTimersByTimeAsync(500);
    expect(write).toHaveBeenCalledTimes(1);
    saver.schedule(scene(2), "s2");
    release(20);
    await vi.advanceTimersByTimeAsync(600);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith(scene(2), 20);
    expect(saver.mtime).toBe(30);
  });

  it("stops on a stale write instead of retrying, and can overwrite on request", async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error("stale")).mockResolvedValueOnce(99);
    const { saver, states } = make(write);
    saver.setBase(10, "s0");
    saver.schedule(scene(1), "s1");
    await vi.advanceTimersByTimeAsync(500);
    expect(states[states.length - 1]).toBe("conflict");
    saver.schedule(scene(2), "s2");
    await vi.advanceTimersByTimeAsync(5000);
    expect(write).toHaveBeenCalledTimes(1);

    await saver.overwrite(50);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![1]).toBe(50);
    expect(saver.mtime).toBe(99);
    expect(states[states.length - 1]).toBe("saved");
  });

  it("reports another failure as an error and keeps the change for the next attempt", async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce(12);
    const { saver, states } = make(write);
    saver.setBase(10, "s0");
    saver.schedule(scene(1), "s1");
    await vi.advanceTimersByTimeAsync(500);
    expect(states[states.length - 1]).toBe("error");
    expect(saver.hasUnsaved).toBe(true);
    await saver.flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(states[states.length - 1]).toBe("saved");
  });

  it("flush writes at once, without waiting for the debounce", async () => {
    const write = vi.fn().mockResolvedValue(11);
    const { saver } = make(write);
    saver.setBase(10, "s0");
    saver.schedule(scene(1), "s1");
    await saver.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(saver.hasUnsaved).toBe(false);
  });

  it("writes nothing after it is disposed", async () => {
    const write = vi.fn().mockResolvedValue(11);
    const { saver } = make(write);
    saver.setBase(10, "s0");
    saver.schedule(scene(1), "s1");
    saver.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(write).not.toHaveBeenCalled();
  });
});
