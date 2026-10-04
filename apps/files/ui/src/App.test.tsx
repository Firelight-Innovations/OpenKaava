// @vitest-environment jsdom
/**
 * The explorer's live reload: it asks the backend to watch its root, and re-lists when the
 * shell relays `files:changed` for that root. Everything below the app is mocked; what is
 * under test is the wiring in `App`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const handlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
const watchRoot = vi.hoisted(() => vi.fn());

vi.mock("@openkaava/bridge", () => ({
  on: (event: string, cb: (payload: unknown) => void) => {
    handlers.set(event, cb);
    return () => handlers.delete(event);
  },
  openIn: vi.fn(),
  publish: vi.fn(),
  reportPainted: vi.fn(),
  subscribe: () => () => {},
}));

vi.mock("./rpc", () => ({
  describe: (_m: string, e: unknown) => String(e),
  getRoot: () => Promise.resolve({ path: "C:/proj", name: "proj", readOnly: false }),
  watchRoot,
}));

vi.mock("./explorer/Explorer", () => ({
  default: ({ reloadNonce }: { reloadNonce: number }) => (
    <div data-testid="tree">{reloadNonce}</div>
  ),
}));
vi.mock("./commands", () => ({ useMenuCommands: () => {} }));
vi.mock("./useDelete", () => ({
  useDelete: () => ({ ask: vi.fn(), notice: null, cancel: vi.fn() }),
}));

import App from "./App";

beforeEach(() => {
  handlers.clear();
  watchRoot.mockReset();
  watchRoot.mockResolvedValue({ root: "C:\proj" });
});
afterEach(cleanup);

describe("File Explorer live reload", () => {
  it("asks the backend to watch its root once the root is known", async () => {
    render(<App />);
    await waitFor(() => expect(watchRoot).toHaveBeenCalledTimes(1));
  });

  it("re-lists when files change under its own root, whatever the slashes or case", async () => {
    render(<App />);
    await waitFor(() => expect(handlers.has("files:changed")).toBe(true));
    await waitFor(() => expect(watchRoot).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByTestId("tree").textContent).toBe("0");

    await act(async () => {
      handlers.get("files:changed")?.({ root: "c:/PROJ/" });
    });
    expect(screen.getByTestId("tree").textContent).toBe("1");
  });

  it("ignores a change under some other project", async () => {
    render(<App />);
    await waitFor(() => expect(watchRoot).toHaveBeenCalled());
    await act(async () => {
      handlers.get("files:changed")?.({ root: "C:/elsewhere" });
    });
    expect(screen.getByTestId("tree").textContent).toBe("0");
  });
});
