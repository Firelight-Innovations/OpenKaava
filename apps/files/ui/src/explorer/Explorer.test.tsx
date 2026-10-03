// @vitest-environment jsdom
/** Keyboard navigation of the tree: Enter on a folder opens and closes it. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@openkaava/bridge", () => ({
  invoke,
  subscribe: () => () => {},
  host: () => "standalone",
  claimSearch: () => ({ release: () => {}, update: () => {} }),
  KaavaRpcError: class extends Error {
    code = 0;
  },
}));

import Explorer from "./Explorer";

const dir = (name: string, path: string) => ({ name, path, kind: "dir", size: null, mtime: null });
const file = (name: string, path: string) => ({ name, path, kind: "file", size: 1, mtime: 1 });

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("Explorer keyboard", () => {
  it("opens and closes a folder with Enter, starting from a fresh tree", async () => {
    invoke.mockImplementation(async (method: string, params?: { path?: string }) => {
      if (method === "files/list") {
        if (params?.path === "/p") {
          return { path: "/p", parent: null, entries: [dir("src", "/p/src")] };
        }
        return { path: "/p/src", parent: "/p", entries: [file("a.ts", "/p/src/a.ts")] };
      }
      return null;
    });
    render(
      <Explorer
        root={{ path: "/p", name: "p" }}
        reloadNonce={0}
        selectedPath={null}
        onFirstListing={() => {}}
        onRefresh={() => {}}
        onOpenFile={() => {}}
        onRenamed={() => {}}
        onDelete={() => {}}
      />,
    );
    const tree = await screen.findByRole("tree");
    await screen.findByText("src");

    // Nothing under the cursor yet: the first Enter only lands on the first row.
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(screen.queryByText("a.ts")).toBeNull();
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(await screen.findByText("a.ts")).toBeTruthy();

    fireEvent.keyDown(tree, { key: "Enter" });
    await waitFor(() => expect(screen.queryByText("a.ts")).toBeNull());
  });
});
