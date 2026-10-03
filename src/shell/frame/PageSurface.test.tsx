// @vitest-environment jsdom
/**
 * The rail page's pull-out: what it paints, that it never remounts what is
 * inside it, and that a close still unmounts once the exit has played.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import type { FrameSlots } from "../contract";
import Frame from "./Frame";
import { pageFrame } from "./PageSurface";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// framer reads matchMedia once per process and caches the answer, so a test
// cannot flip the preference through the browser. Frame asks framer's hook;
// replace the hook and flip the flag.
const pref = vi.hoisted(() => ({ reduce: false }));
vi.mock("framer-motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("framer-motion")>()),
  useReducedMotion: () => pref.reduce,
}));
function setReducedMotion(reduce: boolean) {
  pref.reduce = reduce;
}

const mounts = { count: 0 };
function Probe() {
  useEffect(() => {
    mounts.count += 1;
  }, []);
  return <div data-testid="host">host</div>;
}

function slots(page: ReactNode): FrameSlots {
  return {
    titleBar: <div />,
    toolWindow: <div>tools</div>,
    statusBar: <div />,
    projectRail: <nav>rail</nav>,
    projectPage: page,
    projectPageExpanded: page,
  };
}

describe("pageFrame", () => {
  it("tucks a docked page fully into the rail at 0 and settles it at 1", () => {
    expect(pageFrame(0, "docked", false)).toMatchObject({ x: "100%", opacity: 0 });
    expect(pageFrame(1, "docked", false)).toEqual({ x: "0%", clipPath: "none", opacity: 1 });
  });

  it("reveals an expanded page from the rail side by clip, not by scaling", () => {
    expect(pageFrame(0.5, "expanded", false).clipPath).toBe("inset(0% 0% 0% 50%)");
    expect(pageFrame(0.5, "expanded", false).x).toBe("0%");
  });

  it("does not move under reduced motion, only fades", () => {
    for (const mode of ["docked", "expanded"] as const) {
      expect(pageFrame(0.5, mode, true)).toEqual({ x: "0%", clipPath: "none", opacity: 0.5 });
    }
  });

  it("clamps overshoot so a spring cannot produce an invalid clip", () => {
    expect(pageFrame(1.08, "expanded", false).clipPath).toBe("inset(0% 0% 0% 0%)");
  });
});

describe("Frame's rail page", () => {
  it("skips the animation under reduced motion and unmounts on close at once", () => {
    setReducedMotion(true);
    const { container, rerender } = render(<Frame kind="main" slots={slots(<Probe />)} />);
    const page = container.querySelector('[data-region="page"]') as HTMLElement;
    expect(page.style.transform === "" || !page.style.transform.includes("100%")).toBe(true);
    rerender(<Frame kind="main" slots={slots(null)} />);
    expect(container.querySelector('[data-region="page"]')).toBeNull();
  });

  it("keeps the page mounted through the exit, then unmounts it", async () => {
    setReducedMotion(false);
    const { container, rerender } = render(<Frame kind="main" slots={slots(<Probe />)} />);
    expect(container.querySelector('[data-region="page"]')).not.toBeNull();
    rerender(<Frame kind="main" slots={slots(null)} />);
    expect(container.querySelector('[data-region="page"]')?.hasAttribute("data-leaving")).toBe(
      true,
    );
    await waitFor(() => expect(container.querySelector('[data-region="page"]')).toBeNull(), {
      timeout: 2000,
    });
  });

  it("does not remount the page's content across open, expand and dock", () => {
    setReducedMotion(true);
    mounts.count = 0;
    const { container, rerender } = render(<Frame kind="main" slots={slots(<Probe />)} />);
    const host = container.querySelector('[data-testid="host"]');
    rerender(<Frame kind="main" projectPageExpanded slots={slots(<Probe />)} />);
    expect(container.querySelector('[data-region="page-expanded"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="host"]')).toBe(host);
    rerender(<Frame kind="main" slots={slots(<Probe />)} />);
    expect(container.querySelector('[data-testid="host"]')).toBe(host);
    expect(mounts.count).toBe(1);
  });

  it("clears the docked inline width once the page is expanded", async () => {
    setReducedMotion(true);
    const { container, rerender } = render(<Frame kind="main" slots={slots(<Probe />)} />);
    const docked = container.querySelector<HTMLElement>('[data-region="page"]');
    expect(docked?.style.width).not.toBe("auto");
    rerender(<Frame kind="main" projectPageExpanded slots={slots(<Probe />)} />);
    const expanded = container.querySelector<HTMLElement>('[data-region="page-expanded"]');
    await waitFor(() => expect(expanded?.style.width).toBe("auto"));
  });
});
