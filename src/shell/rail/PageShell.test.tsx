// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PageShell from "./PageShell";

afterEach(cleanup);

describe("PageShell docked header", () => {
  it("offers an expand control beside close", () => {
    const onExpand = vi.fn();
    const onClose = vi.fn();
    render(
      <PageShell
        mode="docked"
        pageId="git"
        title="Git"
        backLabel="main"
        onClose={onClose}
        onExpand={onExpand}
      >
        body
      </PageShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand Git" }));
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close Git" })).toBeTruthy();
  });

  it("draws no expand control without a handler", () => {
    render(
      <PageShell mode="docked" pageId="git" title="Git" backLabel="main" onClose={() => {}}>
        body
      </PageShell>,
    );
    expect(screen.queryByRole("button", { name: "Expand Git" })).toBeNull();
  });
});
