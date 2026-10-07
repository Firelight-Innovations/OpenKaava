// @vitest-environment jsdom
/**
 * Send to agent in the Explorer's right-click menu: drawn for a file only, and
 * an honest error in the menu when the store refuses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@openkaava/bridge", () => ({
  invoke,
  KaavaRpcError: class extends Error {
    code = 0;
  },
}));

import ContextMenu, { type MenuTarget } from "./ContextMenu";

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

const target = (over: Partial<MenuTarget>): MenuTarget => ({
  path: "C:\\game\\src\\a.ts",
  createIn: "C:\\game\\src",
  name: "a.ts",
  kind: "file",
  x: 0,
  y: 0,
  ...over,
});

function open(t: MenuTarget) {
  render(
    <ContextMenu
      target={t}
      rootPath={"C:\\game"}
      onCreate={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("Send to agent", () => {
  it("appears for a file", () => {
    open(target({}));
    expect(screen.getByRole("menuitem", { name: "Send to agent" })).toBeTruthy();
  });

  it("does not appear for a folder or blank space", () => {
    open(target({ kind: "dir", path: "C:\\game\\src" }));
    expect(screen.queryByRole("menuitem", { name: "Send to agent" })).toBeNull();
    cleanup();
    open(target({ path: null, name: null, kind: null }));
    expect(screen.queryByRole("menuitem", { name: "Send to agent" })).toBeNull();
  });

  it("puts the file by path", async () => {
    invoke.mockResolvedValue({ id: "ctx-1" });
    open(target({}));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send to agent" }));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith(
      "context/put",
      expect.objectContaining({ kind: "file", path: "C:\\game\\src\\a.ts" }),
    );
  });

  it("says why when the store refuses", async () => {
    invoke.mockRejectedValue(new Error("over the 25 MB copy limit"));
    open(target({}));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send to agent" }));
    await waitFor(() => expect(screen.getByText(/25 MB copy limit/)).toBeTruthy());
  });
});

describe("the menu over blank space (the project root)", () => {
  const root = target({ path: "C:\\game", createIn: "C:\\game", name: null, kind: "dir" });
  const labels = () => screen.getAllByRole("menuitem").map((el) => el.textContent);

  it("offers the folder-level items and no Rename or Delete", () => {
    open(root);
    expect(labels()).toEqual(["New File", "New Folder", "Copy path", "Reveal in File Explorer"]);
  });

  it("copies the root's own path", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    open(root);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("C:\\game"));
  });

  it("opens the root folder itself rather than revealing it inside its parent", async () => {
    invoke.mockResolvedValue(null);
    open(root);
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in File Explorer" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("files/open-external", { path: "C:\\game" }),
    );
  });

  it("still reveals an ordinary row", async () => {
    invoke.mockResolvedValue(null);
    open(target({}));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in File Explorer" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("files/reveal", { path: "C:\\game\\src\\a.ts" }),
    );
  });
});
