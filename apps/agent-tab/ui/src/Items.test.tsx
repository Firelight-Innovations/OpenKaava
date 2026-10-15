// @vitest-environment jsdom
/**
 * The item renderers on their own: what an agent's Markdown may do when it is
 * clicked, and the approval card's diff and cut-off notice.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ItemView } from "./Items";
import type { FileDiff, Item } from "./protocol.generated";

afterEach(cleanup);

const actions = { onAnswer: () => Promise.resolve(), onRetry: () => {} };

function view(item: Item) {
  return render(<ItemView item={item} actions={actions} />);
}

const reply = (text: string): Item => ({
  id: "a1",
  turnId: "t1",
  kind: { kind: "assistantText", text },
});

describe("an agent's Markdown", () => {
  it("never lets a click or a middle click on a link navigate the frame", () => {
    view(reply("see [the docs](https://example.com/docs)"));
    const link = screen.getByRole("link", { name: "the docs" });
    // fireEvent returns false when the default was prevented.
    expect(fireEvent.click(link)).toBe(false);
    const middle = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    expect(fireEvent(link, middle)).toBe(false);
  });

  it("does not make a link of a javascript: address", () => {
    view(reply("[run it](javascript:alert(1))"));
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("copies the text of a fenced block from its button", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    view(reply("```sh\nnpm test\n```"));
    const copy = screen.getByRole("button", { name: "Copy" });
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith("npm test\n");
    await waitFor(() => expect(copy.textContent).toBe("Copied"));
  });
});

const diff = (path: string, oldText: string | null, newText: string): FileDiff => ({
  path,
  oldText,
  newText,
  tooLarge: false,
});

const approval = (over: Partial<Extract<Item["kind"], { kind: "approval" }>>): Item => ({
  id: "p1",
  turnId: "t1",
  kind: {
    kind: "approval",
    title: "Edit a.txt",
    toolCallId: "c1",
    detail: null,
    detailTruncated: false,
    paths: [],
    diffs: [],
    options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    answer: null,
    ...over,
  },
});

describe("an approval card", () => {
  it("shows the change an edit would make, line by line", () => {
    view(approval({ diffs: [diff("C:/w/a.txt", "one\ntwo\n", "one\nthree\n")] }));
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    expect(screen.getByText("- two")).toBeTruthy();
    expect(screen.getByText("+ three")).toBeTruthy();
    expect(screen.getByText("C:/w/a.txt")).toBeTruthy();
  });

  it("draws several diffs of one file without a duplicate key", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    view(
      approval({
        paths: ["C:/w/a.txt", "C:/w/a.txt"],
        diffs: [diff("C:/w/a.txt", "a", "b"), diff("C:/w/a.txt", "c", "d")],
      }),
    );
    expect(screen.getAllByText("C:/w/a.txt").length).toBeGreaterThanOrEqual(2);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("says when the command shown is only the start of it", () => {
    view(approval({ detail: "rm -rf build", detailTruncated: true }));
    expect(screen.getByText("rm -rf build")).toBeTruthy();
    expect(screen.getByText(/Only the start of this is shown/)).toBeTruthy();
  });

  it("says nothing of the sort for a command shown in full", () => {
    view(approval({ detail: "ls" }));
    expect(screen.queryByText(/Only the start of this is shown/)).toBeNull();
  });
});
