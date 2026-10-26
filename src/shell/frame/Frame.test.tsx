// @vitest-environment jsdom
/**
 * The right side of the window: one sidebar, and none at all with no page open.
 *
 * Review round 1 found two sidebars (a secondary panel and the docked page)
 * and an empty bordered column whenever no page was open. These pin both.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MotionGlobalConfig } from "framer-motion";
import type { FrameSlots } from "../contract";
import Frame from "./Frame";

afterEach(cleanup);

beforeAll(() => {
  // jsdom has no ResizeObserver, and `Frame` observes the band's column.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function slots(extra: Partial<FrameSlots> = {}): FrameSlots {
  return {
    titleBar: <div />,
    toolWindow: <div>tools</div>,
    statusBar: <div />,
    projectRail: <nav>rail</nav>,
    ...extra,
  };
}

describe("Frame's right side", () => {
  it("draws no docked column, handle or border when no page is open", () => {
    // `rightPage && <DockedPage/>` is `null` with no page open.
    const { container } = render(<Frame kind="main" slots={slots({ projectPage: null })} />);
    expect(container.querySelector('[data-region="page"]')).toBeNull();
    expect(container.querySelector('[data-region="pagehandle"]')).toBeNull();
    expect(container.querySelector('[data-region="rail"]')).not.toBeNull();
  });

  it("draws no separate secondary panel beside the docked page", () => {
    const { container } = render(
      <Frame kind="main" slots={slots({ projectPage: <div>git page</div> })} />,
    );
    expect(container.querySelector('[data-region="page"]')?.textContent).toBe("git page");
    expect(container.querySelector('[data-region="panel"]')).toBeNull();
    expect(container.querySelector('[data-region="handle"]')).toBeNull();
  });

  it("swaps the docked column for the expanded page", () => {
    const { container } = render(
      <Frame
        kind="main"
        projectPageExpanded
        slots={slots({ projectPage: <div />, projectPageExpanded: <div>expanded</div> })}
      />,
    );
    expect(container.querySelector('[data-region="page"]')).toBeNull();
    expect(container.querySelector('[data-region="page-expanded"]')?.textContent).toBe("expanded");
  });
});

describe("Frame's docked page handle", () => {
  it("puts the page's leading edge under the pointer, past the rail, margin and border", () => {
    const widths: number[] = [];
    const { container } = render(
      <Frame
        kind="main"
        slots={slots({ projectPage: <div>page</div> })}
        onProjectPageWidthChange={(w) => widths.push(w)}
      />,
    );
    const split = container.querySelector(".frame__split") as HTMLElement;
    split.getBoundingClientRect = () => ({ right: 1000, width: 1000 }) as DOMRect;
    const handle = container.querySelector('[data-region="pagehandle"]') as HTMLElement;

    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientX: 566 }));
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 500 }));
      window.dispatchEvent(new MouseEvent("pointerup"));
    });

    // 1000 (row right) - 44 (rail) - 7 (box margin + border) - 500 (pointer) = 449.
    expect(widths).toEqual([449]);
  });

  // A popped-out window is as narrow as 480px: dragging the page wide there must leave the panes
  // their minimum rather than push the rail off the edge.
  it("holds the page back in a narrow window so the panes keep their width", () => {
    const widths: number[] = [];
    const { container } = render(
      <Frame
        kind="detached"
        slots={slots({ projectPage: <div>page</div> })}
        onProjectPageWidthChange={(w) => widths.push(w)}
      />,
    );
    const split = container.querySelector(".frame__split") as HTMLElement;
    split.getBoundingClientRect = () => ({ right: 600, width: 600 }) as DOMRect;
    const handle = container.querySelector('[data-region="pagehandle"]') as HTMLElement;

    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientX: 300 }));
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 50 }));
      window.dispatchEvent(new MouseEvent("pointerup"));
    });

    // 600 - 44 (rail) - 7 (margin + border) - 240 (panes' minimum) = 309.
    expect(widths).toEqual([309]);
  });
});

describe("Frame's terminal band", () => {
  it("puts the band straight under the tool window", () => {
    const { container } = render(<Frame kind="main" slots={slots({ bottomPanel: <div /> })} />);
    const handle = container.querySelector('[data-region="bottomhandle"]');
    expect(handle?.previousElementSibling?.getAttribute("data-region")).toBe("toolwindow");
  });

  it("stops a drag where the tool window keeps its minimum", () => {
    const heights: number[] = [];
    const { container } = render(
      <Frame
        kind="main"
        slots={slots({ bottomPanel: <div>band</div> })}
        bottomCollapsed={false}
        onBottomHeightChange={(h) => heights.push(h)}
      />,
    );
    const main = container.querySelector(".frame__main") as HTMLElement;
    main.getBoundingClientRect = () => ({ height: 600, bottom: 600 }) as DOMRect;
    const handle = container.querySelector('[data-region="bottomhandle"]') as HTMLElement;
    handle.getBoundingClientRect = () => ({ height: 6 }) as DOMRect;

    // 500 asked for: past the 474 limit, short of the 60px overshoot that maximizes.
    fireEvent(handle, new MouseEvent("pointerdown", { bubbles: true, clientY: 400 }));
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientY: 100 }));
      window.dispatchEvent(new MouseEvent("pointerup"));
    });

    // 600 (column) - 6 (handle) - 120 (tool window minimum) = 474.
    expect(heights).toEqual([474]);
  });

  // Each observer the frame makes, with what it watches and what it runs.
  let observers: { seen: Element[]; resized: () => void }[] = [];
  const realObserver = globalThis.ResizeObserver;
  const realRect = Element.prototype.getBoundingClientRect;
  const observeByHand = () => {
    observers = [];
    globalThis.ResizeObserver = class {
      readonly seen: Element[] = [];
      constructor(callback: ResizeObserverCallback) {
        observers.push({ seen: this.seen, resized: () => callback([], this) });
      }
      observe(el: Element) {
        this.seen.push(el);
      }
      unobserve() {}
      disconnect() {}
    };
  };
  const restore = () => {
    globalThis.ResizeObserver = realObserver;
    Element.prototype.getBoundingClientRect = realRect;
  };

  it("re-fits a maximized band to the column when the column changes size", async () => {
    observeByHand();
    // The mount's spring is not under test here, and while one runs, each of its
    // steps overwrites what the observer writes. Waiting for it to read 0px was
    // flaky on a slow runner. With animations skipped it lands at once and stops.
    MotionGlobalConfig.skipAnimations = true;
    try {
      const { container } = render(
        <Frame
          kind="main"
          slots={slots({ bottomPanel: <div>band</div> })}
          bottomCollapsed={false}
          bottomMaximized
        />,
      );
      const main = container.querySelector(".frame__main") as HTMLElement;
      const column = observers.filter((o) => o.seen.includes(main)).pop();
      expect(column?.seen).toEqual([main]);
      // The mount lands on the fit jsdom measures, 0px.
      const band = container.querySelector('[data-region="bottom"]') as HTMLElement;
      await waitFor(() => expect(band.style.height).toBe("0px"));

      main.getBoundingClientRect = () => ({ height: 700 }) as DOMRect;
      const handle = container.querySelector('[data-region="bottomhandle"]') as HTMLElement;
      handle.getBoundingClientRect = () => ({ height: 6 }) as DOMRect;
      act(() => column?.resized());

      // 700 (column) - 6 (handle) = 694: the whole column, with no tool window left.
      await waitFor(() => expect(band.style.height).toBe("694px"));
      await new Promise((r) => setTimeout(r, 300));
      expect(band.style.height).toBe("694px");
    } finally {
      MotionGlobalConfig.skipAnimations = false;
      restore();
    }
  });

  it("lets a maximized band spring open, though its observer reports as it starts", async () => {
    observeByHand();
    // The column's size from the first layout on, as a browser has it before any observer starts.
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.classList.contains("frame__main")) return { height: 700 } as DOMRect;
      if (this.getAttribute("data-region") === "bottomhandle") return { height: 6 } as DOMRect;
      return realRect.call(this);
    };
    try {
      const band = <div>band</div>;
      const { container, rerender } = render(
        <Frame kind="main" slots={slots({ bottomPanel: band })} bottomCollapsed bottomMaximized />,
      );
      rerender(
        <Frame
          kind="main"
          slots={slots({ bottomPanel: band })}
          bottomCollapsed={false}
          bottomMaximized
        />,
      );
      const main = container.querySelector(".frame__main") as HTMLElement;
      // The observer the open started reports at once, with the height the column already had.
      act(() =>
        observers
          .filter((o) => o.seen.includes(main))
          .pop()
          ?.resized(),
      );

      const bottom = container.querySelector('[data-region="bottom"]') as HTMLElement;
      await new Promise((r) => setTimeout(r, 100));
      const midway = parseFloat(bottom.style.height);
      expect(midway).toBeGreaterThan(0);
      expect(midway).toBeLessThan(694);
      await waitFor(() => expect(bottom.style.height).toBe("694px"));
    } finally {
      restore();
    }
  });
});
