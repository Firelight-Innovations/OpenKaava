import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFitController, FIT_DEBOUNCE_MS } from "./fitController";
import { beginResize, isResizing, resetResizing, subscribeResizing } from "../resizeGate";

function setup(box = { width: 700, height: 900 }, dims = { cols: 80, rows: 40 }) {
  const state = { box, dims };
  const fit = vi.fn();
  const resize = vi.fn();
  const controller = createFitController({
    measure: () => state.box,
    propose: () => state.dims,
    fit,
    resize,
    isResizing,
    subscribeResizing,
  });
  return { state, fit, resize, controller };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetResizing();
});

afterEach(() => {
  resetResizing();
  vi.useRealTimers();
});

describe("fit controller", () => {
  it("fits at once the first time there is a real size", () => {
    const { controller, fit, resize } = setup();
    controller.notify();
    expect(fit).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(80, 40);
    controller.dispose();
  });

  it("sends no pty resize during a drag and exactly one on release", () => {
    const { controller, state, fit, resize } = setup();
    controller.notify();
    fit.mockClear();
    resize.mockClear();

    const end = beginResize();
    for (let i = 0; i < 60; i++) {
      state.box = { width: 700 - i * 3, height: 900 };
      state.dims = { cols: 80 - i, rows: 40 };
      controller.notify();
      vi.advanceTimersByTime(16);
    }
    vi.advanceTimersByTime(1000);
    expect(fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();

    end();
    expect(fit).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(21, 40);

    vi.advanceTimersByTime(1000);
    expect(resize).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("coalesces non-drag resizes into one fit after the size settles", () => {
    const { controller, state, fit, resize } = setup();
    controller.notify();
    fit.mockClear();
    resize.mockClear();

    for (let i = 0; i < 20; i++) {
      state.box = { width: 700 + i, height: 900 };
      state.dims = { cols: 80 + i, rows: 40 };
      controller.notify();
      vi.advanceTimersByTime(16);
    }
    expect(fit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FIT_DEBOUNCE_MS);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(99, 40);
    controller.dispose();
  });

  it("drops a pending debounce when a drag begins", () => {
    const { controller, state, fit, resize } = setup();
    controller.notify();
    fit.mockClear();
    resize.mockClear();

    state.dims = { cols: 90, rows: 40 };
    controller.notify();
    const end = beginResize();
    vi.advanceTimersByTime(1000);
    expect(fit).not.toHaveBeenCalled();
    end();
    expect(resize).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("never fits a hidden or 0x0 container, and fits at once when it returns", () => {
    const { controller, state, fit, resize } = setup({ width: 0, height: 0 });
    controller.notify();
    vi.advanceTimersByTime(1000);
    expect(fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();

    state.box = { width: 700, height: 900 };
    controller.notify();
    expect(fit).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("skips a proposal that is not a finite positive size", () => {
    const { controller, state, fit, resize } = setup();
    state.dims = { cols: 0, rows: 40 };
    controller.notify();
    state.dims = { cols: Number.NaN, rows: 40 };
    controller.notify();
    expect(fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("does not repeat a pty resize when the grid is unchanged", () => {
    const { controller, resize } = setup();
    controller.notify();
    controller.notify();
    vi.advanceTimersByTime(FIT_DEBOUNCE_MS);
    expect(resize).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("holds until every overlapping drag has ended", () => {
    const { controller, resize } = setup();
    controller.notify();
    resize.mockClear();
    const a = beginResize();
    const b = beginResize();
    a();
    expect(isResizing()).toBe(true);
    b();
    expect(isResizing()).toBe(false);
    controller.dispose();
  });
});
