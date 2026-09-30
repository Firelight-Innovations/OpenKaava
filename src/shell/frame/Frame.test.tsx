// @vitest-environment jsdom
/**
 * The right side of the window: one sidebar, and none at all with no page open.
 *
 * Review round 1 found two sidebars (a secondary panel and the docked page)
 * and an empty bordered column whenever no page was open. These pin both.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
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
