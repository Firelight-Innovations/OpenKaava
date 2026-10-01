// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import SearchSlot from "./SearchSlot";
import { claimTitlebarSearch, resetTitlebarSearch } from "../titlebarSearch";

afterEach(() => {
  cleanup();
  resetTitlebarSearch();
});

describe("SearchSlot", () => {
  it("is the project search trigger when nothing has claimed it", () => {
    const onOpen = vi.fn();
    render(<SearchSlot onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Search project files" }));
    expect(onOpen).toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("becomes the claimant's input and reverts on release", () => {
    const onChange = vi.fn();
    render(<SearchSlot onOpen={() => {}} />);
    let handle!: ReturnType<typeof claimTitlebarSearch>;
    act(() => {
      handle = claimTitlebarSearch({ placeholder: "Search settings", value: "", onChange });
    });
    const input = screen.getByRole("textbox", { name: "Search settings" });
    fireEvent.change(input, { target: { value: "font" } });
    expect(onChange).toHaveBeenCalledWith("font");
    expect(screen.queryByRole("button", { name: "Search project files" })).toBeNull();
    act(() => handle.release());
    expect(screen.getByRole("button", { name: "Search project files" })).toBeTruthy();
  });

  it("focuses the claimed input on Ctrl+K instead of opening the dialog", () => {
    const onOpen = vi.fn();
    render(<SearchSlot onOpen={onOpen} />);
    act(() => {
      claimTitlebarSearch({ placeholder: "Search settings", value: "", onChange: () => {} });
    });
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(onOpen).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });
});
