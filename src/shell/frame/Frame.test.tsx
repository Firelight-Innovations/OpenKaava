// @vitest-environment jsdom
/**
 * The right side of the window: one sidebar, and none at all with no page open.
 *
 * Review round 1 found two sidebars (a secondary panel and the docked page)
 * and an empty bordered column whenever no page was open. These pin both.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
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
