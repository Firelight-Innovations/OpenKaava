// @vitest-environment jsdom
/**
 * The search dialog is a presentation over `useSearchSession`, so these tests
 * hand it a fixed session and pin what the dialog itself is responsible for:
 * the dialog shell, grouping headings, the type chips, and the keys.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import SearchOverlay from "./SearchOverlay";
import { parseQuery } from "./query";
import type { SearchSession } from "./useSearchSession";
import type { ResultRow, SearchHit } from "./types";

afterEach(cleanup);

const script: SearchHit = { path: "/p/src/a.ts", name: "a.ts", kind: "script", matches: [] };
const content: SearchHit = { path: "/p/docs/b.md", name: "b.md", kind: "content", matches: [] };

function session(overrides: Partial<SearchSession> = {}): SearchSession {
  const rows: ResultRow[] = [
    { row: "file", hit: script },
    { row: "file", hit: content },
  ];
  return {
    query: "a",
    setQuery: vi.fn(),
    parsed: parseQuery("a"),
    kinds: ["script", "data", "content", "kaava"],
    toggleKind: vi.fn(),
    hits: [script, content],
    rows,
    matchCount: 0,
    searching: false,
    activeIndex: 0,
    setActiveIndex: vi.fn(),
    moveActive: vi.fn(),
    focus: null,
    reset: vi.fn(),
    ...overrides,
  };
}

function renderOverlay(s: SearchSession, handlers: Partial<Record<string, () => void>> = {}) {
  const onClose = handlers.onClose ?? vi.fn();
  const onSubmit = handlers.onSubmit ?? vi.fn();
  const onOpen = vi.fn();
  render(
    <SearchOverlay
      session={s}
      root="/p"
      clusterId="c1"
      onOpen={onOpen}
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );
  return { onClose, onSubmit, onOpen };
}

describe("SearchOverlay", () => {
  it("renders a labelled modal dialog with the field focused", () => {
    renderOverlay(session());
    expect(screen.getByRole("dialog", { name: "Search" }).getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("Search this project"));
  });

  it("draws one heading per kind, in filter order", () => {
    renderOverlay(session());
    const headings = Array.from(document.querySelectorAll(".search-dialog__group")).map(
      (el) => el.textContent,
    );
    expect(headings).toEqual(["Scripts", "Content"]);
  });

  it("shows the type count and toggles a kind from its chip", () => {
    const s = session();
    renderOverlay(s);
    expect(screen.getByText("4 of 4 types")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    expect(s.toggleKind).toHaveBeenCalledWith("data");
  });

  it("closes on Escape and on a scrim press, not on a panel press", () => {
    const { onClose } = renderOverlay(session());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(document.querySelector(".search-dialog__scrim") as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("moves the cursor with the arrow keys and opens on Enter", () => {
    const s = session();
    const { onSubmit } = renderOverlay(s);
    const input = screen.getByLabelText("Search this project");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(s.moveActive).toHaveBeenCalledWith(1);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(s.moveActive).toHaveBeenCalledWith(-1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("opens the clicked row's file", () => {
    const { onOpen } = renderOverlay(session());
    fireEvent.click(screen.getByText("b.md"));
    expect(onOpen).toHaveBeenCalledWith("/p/docs/b.md");
  });

  it("says so when no project is open", () => {
    render(
      <SearchOverlay
        session={session({ rows: [] })}
        root={null}
        clusterId={null}
        onOpen={vi.fn()}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("No project open in this cluster")).toBeTruthy();
  });
});
