// @vitest-environment jsdom
/**
 * The Context strip: hidden when empty, one chip per item, remove and re-insert
 * reaching Rust with the terminal's id, a greyed chip for a file that has gone,
 * and a collapse that keeps the count.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ContextItem } from "../../bindings";

const {
  contextList,
  contextRemove,
  contextThumb,
  onContextChanged,
  terminalHarness,
  terminalSetHarness,
  terminalInsertItems,
} = vi.hoisted(() => ({
  contextList: vi.fn(),
  contextRemove: vi.fn(),
  contextThumb: vi.fn(),
  onContextChanged: vi.fn(),
  terminalHarness: vi.fn(),
  terminalSetHarness: vi.fn(),
  terminalInsertItems: vi.fn(),
}));

vi.mock("../../bindings", () => ({
  contextList,
  contextRemove,
  contextThumb,
  onContextChanged,
  terminalHarness,
  terminalSetHarness,
  terminalInsertItems,
}));

import ContextStrip, { ContextNotice, formatSize, itemMeta } from "./ContextStrip";
import { clear, notify } from "../terminalNotice";

function item(over: Partial<ContextItem> = {}): ContextItem {
  return {
    id: "ctx_a",
    v: 1,
    kind: "image",
    mime: "image/png",
    title: "Play frame",
    source: { appId: "play" },
    method: "put",
    createdAt: 1,
    size: 2048,
    path: "C:/p/.kaava/context/a.png",
    relPath: ".kaava/context/a.png",
    owned: true,
    image: { width: 640, height: 480 },
    missing: false,
    ...over,
  };
}

let changed: (() => void) | null = null;

beforeEach(() => {
  changed = null;
  onContextChanged.mockImplementation((cb: () => void) => {
    changed = cb;
    return Promise.resolve(() => {});
  });
  contextThumb.mockResolvedValue(["image/png", "AAAA"]);
  terminalHarness.mockResolvedValue({ effective: "claude", detected: "claude", overridden: null });
  terminalSetHarness.mockResolvedValue(undefined);
  terminalInsertItems.mockResolvedValue({
    text: "",
    count: 0,
    harness: "claude",
    items: [],
    refused: [],
  });
  contextRemove.mockResolvedValue(undefined);
  try {
    localStorage.clear();
  } catch {
    // jsdom has storage; the guard mirrors the component's.
  }
});

afterEach(() => {
  cleanup();
  clear("t1");
  vi.clearAllMocks();
});

describe("ContextStrip", () => {
  it("renders nothing while the environment has no context", async () => {
    contextList.mockResolvedValue([]);
    const { container } = render(<ContextStrip sessionId="t1" />);
    await waitFor(() => expect(contextList).toHaveBeenCalledWith("t1"));
    expect(container.querySelector(".ctxstrip")).toBeNull();
  });

  it("shows a chip per item with its dimensions and size", async () => {
    contextList.mockResolvedValue([
      item(),
      item({
        id: "ctx_b",
        title: "Log",
        kind: "text",
        image: undefined,
        text: { chars: 9, lines: 3, truncated: false },
        size: 900,
      }),
    ]);
    render(<ContextStrip sessionId="t1" />);
    expect(await screen.findByText("Play frame")).toBeTruthy();
    expect(screen.getByText("640 × 480 · 2 KB")).toBeTruthy();
    expect(screen.getByText("3 lines · 900 B")).toBeTruthy();
  });

  it("loads a thumbnail for an image and puts it in the chip", async () => {
    contextList.mockResolvedValue([item({ id: "ctx_thumb" })]);
    const { container } = render(<ContextStrip sessionId="t1" />);
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/png;base64,AAAA",
      ),
    );
    expect(contextThumb).toHaveBeenCalledWith("t1", "ctx_thumb");
  });

  it("re-inserts and removes by the terminal's id", async () => {
    contextList.mockResolvedValue([item()]);
    render(<ContextStrip sessionId="t1" />);
    fireEvent.click(await screen.findByLabelText("Insert Play frame at the prompt"));
    expect(terminalInsertItems).toHaveBeenCalledWith("t1", ["ctx_a"]);
    fireEvent.click(screen.getByLabelText("Remove Play frame"));
    expect(contextRemove).toHaveBeenCalledWith("t1", "ctx_a");
  });

  it("greys a chip whose file is gone and will not insert it", async () => {
    contextList.mockResolvedValue([item({ missing: true })]);
    render(<ContextStrip sessionId="t1" />);
    const insert = (await screen.findByLabelText(
      "Insert Play frame at the prompt",
    )) as HTMLButtonElement;
    expect(insert.disabled).toBe(true);
    expect(screen.getByText("File missing")).toBeTruthy();
    expect(contextThumb).not.toHaveBeenCalled();
  });

  it("refetches when the backend says a store changed", async () => {
    contextList.mockResolvedValueOnce([]).mockResolvedValue([item()]);
    render(<ContextStrip sessionId="t1" />);
    await waitFor(() => expect(changed).not.toBeNull());
    await act(async () => changed?.());
    expect(await screen.findByText("Play frame")).toBeTruthy();
  });

  it("collapses to a bar that keeps the count, and remembers it", async () => {
    contextList.mockResolvedValue([item(), item({ id: "ctx_b" })]);
    render(<ContextStrip sessionId="t1" />);
    fireEvent.click(await screen.findByLabelText("Hide context"));
    expect(screen.queryByText("Play frame")).toBeNull();
    expect(screen.getByLabelText("Show context, 2 items")).toBeTruthy();
    expect(localStorage.getItem("kaava.contextStrip.collapsed")).toBe("1");
    fireEvent.click(screen.getByLabelText("Show context, 2 items"));
    expect((await screen.findAllByText("Play frame")).length).toBe(2);
  });

  it("labels auto with what was detected and sends an override to Rust", async () => {
    contextList.mockResolvedValue([item()]);
    render(<ContextStrip sessionId="t1" />);
    const select = (await screen.findByLabelText("Insert as")) as HTMLSelectElement;
    await waitFor(() => expect(select.options[0].textContent).toBe("Auto (Claude Code)"));
    fireEvent.change(select, { target: { value: "shell" } });
    expect(terminalSetHarness).toHaveBeenCalledWith("t1", "shell");
  });
});

describe("ContextNotice", () => {
  it("shows the latest notice and marks an error as an alert", async () => {
    render(<ContextNotice sessionId="t1" />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => notify("t1", "Inserted 1 reference for Claude Code"));
    expect(screen.getByRole("status").textContent).toBe("Inserted 1 reference for Claude Code");
    act(() => notify("t1", "Could not paste that image", true));
    expect(screen.getByRole("alert").textContent).toBe("Could not paste that image");
  });
});

describe("chip text", () => {
  it("formats sizes", () => {
    expect(formatSize(12)).toBe("12 B");
    expect(formatSize(340 * 1024)).toBe("340 KB");
    expect(formatSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
  it("says a single line in the singular", () => {
    expect(
      itemMeta(item({ image: undefined, text: { chars: 1, lines: 1, truncated: false }, size: 5 })),
    ).toBe("1 line · 5 B");
  });
});
