// @vitest-environment jsdom
/**
 * The app against a fake backend that behaves like `canvas.rs`: which canvas it
 * opens, what read-only does, what a corrupt file shows, and that a drawing
 * change reaches `canvas/write` with the mtime it read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SceneFile } from "./scene";

const bridge = vi.hoisted(() => {
  class KaavaRpcError extends Error {
    constructor(
      readonly code: number,
      message: string,
      readonly data?: unknown,
    ) {
      super(message);
    }
  }
  return { invoke: vi.fn(), KaavaRpcError };
});

vi.mock("@openkaava/bridge", () => ({
  invoke: bridge.invoke,
  KaavaRpcError: bridge.KaavaRpcError,
  reportPainted: vi.fn(),
}));

// Excalidraw needs a real canvas and layout; the wiring around it is what is under test.
vi.mock("./Editor", () => ({
  default: ({
    initial,
    onChange,
  }: {
    initial: SceneFile;
    onChange: (e: unknown[], a: Record<string, unknown>, f: Record<string, unknown>) => void;
  }) => (
    <div data-testid="editor">
      <span>{initial.elements.length} elements</span>
      <button
        type="button"
        onClick={() =>
          onChange(
            [...initial.elements, { id: "new", type: "rectangle", version: 1, versionNonce: 1 }],
            {},
            {},
          )
        }
      >
        draw
      </button>
    </div>
  ),
}));

import App from "./App";

const scene = (n: number, title = "World"): SceneFile => ({
  type: "excalidraw",
  version: 2,
  elements: Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    type: "rectangle",
    version: 1,
    versionNonce: i,
  })),
  appState: {},
  files: {},
  kaava: { title },
});

interface Backend {
  readOnly: boolean;
  rows: { id: string; title: string; parent: string | null; error: string | null }[];
  reads: Record<string, SceneFile | Error>;
}

function fake(b: Backend) {
  bridge.invoke.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
    switch (method) {
      case "canvas/state":
        return { hasEnvironment: true, readOnly: b.readOnly, dir: "canvas" };
      case "canvas/list":
        return b.rows.map((r) => ({ ...r, mtime: 1, path: `canvas/${r.id}.json` }));
      case "canvas/read": {
        const got = b.reads[params!.id as string]!;
        if (got instanceof Error) throw got;
        return { id: params!.id, path: `canvas/${params!.id}.json`, scene: got, mtime: 100 };
      }
      case "canvas/stat":
        return { mtime: 100 };
      case "canvas/write":
        return { id: params!.id, mtime: 200 };
      case "canvas/create":
        b.rows.push({
          id: params!.id as string,
          title: params!.title as string,
          parent: null,
          error: null,
        });
        b.reads[params!.id as string] = scene(0, params!.title as string);
        return { id: params!.id, path: "x", scene: scene(0), mtime: 100 };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
}

beforeEach(() => {
  bridge.invoke.mockReset();
  localStorage.clear();
});
afterEach(cleanup);

describe("Canvas app", () => {
  it("opens the first root canvas and draws it", async () => {
    fake({
      readOnly: false,
      rows: [
        { id: "levels/ward-b", title: "Ward B", parent: "world", error: null },
        { id: "world", title: "World", parent: null, error: null },
      ],
      reads: { world: scene(3), "levels/ward-b": scene(1, "Ward B") },
    });
    render(<App />);
    expect(await screen.findByText("3 elements")).toBeTruthy();
    expect(screen.getByText("canvas/world.json")).toBeTruthy();
  });

  it("saves a drawing change with the mtime it read", async () => {
    fake({
      readOnly: false,
      rows: [{ id: "world", title: "World", parent: null, error: null }],
      reads: { world: scene(1) },
    });
    render(<App />);
    fireEvent.click(await screen.findByText("draw"));
    await waitFor(
      () => {
        const write = bridge.invoke.mock.calls.find((c) => c[0] === "canvas/write");
        expect(write).toBeTruthy();
        expect(write![1]).toMatchObject({ id: "world", baseMtime: 100 });
        expect(write![1].scene.elements).toHaveLength(2);
      },
      { timeout: 3000 },
    );
    await screen.findByText("Saved");
  });

  it("says main is read-only, disables New canvas, and never writes", async () => {
    fake({
      readOnly: true,
      rows: [{ id: "world", title: "World", parent: null, error: null }],
      reads: { world: scene(1) },
    });
    render(<App />);
    await screen.findByTestId("editor");
    expect(screen.getAllByText(/read-only/i).length).toBeGreaterThan(0);
    expect((screen.getByText("New canvas").closest("button") as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByText("draw"));
    await new Promise((r) => setTimeout(r, 900));
    expect(bridge.invoke.mock.calls.some((c) => c[0] === "canvas/write")).toBe(false);
  });

  it("shows a corrupt file's message and no editor", async () => {
    fake({
      readOnly: false,
      rows: [{ id: "broken", title: "broken", parent: null, error: "x" }],
      reads: {
        broken: new bridge.KaavaRpcError(-32603, "canvas/broken.json is not valid JSON: eof", {
          kind: "corrupt",
        }),
      },
    });
    render(<App />);
    expect(await screen.findByText(/is not valid JSON/)).toBeTruthy();
    expect(screen.getByText(/file was not touched/)).toBeTruthy();
    expect(screen.queryByTestId("editor")).toBeNull();
  });

  it("offers to create the first canvas when there are none", async () => {
    fake({ readOnly: false, rows: [], reads: {} });
    render(<App />);
    const input = await screen.findByLabelText("Canvas name");
    fireEvent.change(input, { target: { value: "Hospital Wing" } });
    expect(screen.getByText("canvas/hospital-wing.json")).toBeTruthy();
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith("canvas/create", {
        id: "hospital-wing",
        title: "Hospital Wing",
        parent: undefined,
      }),
    );
    expect(await screen.findByTestId("editor")).toBeTruthy();
  });
});
