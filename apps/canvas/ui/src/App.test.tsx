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
// The fake keeps the scene it was given, so the app's `updateScene` calls land somewhere.
const live = vi.hoisted(() => ({ elements: [] as unknown[], seed: null as unknown }));

vi.mock("./Editor", () => ({
  default: ({
    initial,
    onChange,
    onApi,
    onOpenChild,
  }: {
    initial: SceneFile;
    onChange: (e: unknown[], a: Record<string, unknown>, f: Record<string, unknown>) => void;
    onApi: (api: unknown) => void;
    onOpenChild: (id: string) => void;
  }) => {
    if (live.seed !== initial) {
      live.seed = initial;
      live.elements = [...initial.elements];
    }
    onApi({
      getSceneElementsIncludingDeleted: () => live.elements,
      updateScene: ({ elements }: { elements: unknown[] }) => {
        live.elements = elements;
      },
      getAppState: () => ({ viewBackgroundColor: "#ffffff" }),
      getFiles: () => ({}),
    });
    const frame = { id: "f1", type: "frame", name: "Ward B", version: 1, versionNonce: 1 };
    return (
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
        <button
          type="button"
          onClick={() => {
            live.elements = [...initial.elements, frame];
            onChange([...initial.elements, frame], { selectedElementIds: { f1: true } }, {});
          }}
        >
          select frame
        </button>
        <button type="button" onClick={() => onOpenChild("world/ward-b")}>
          double-click linked frame
        </button>
        <button type="button" onClick={() => onOpenChild("world/ghost")}>
          double-click dangling frame
        </button>
      </div>
    );
  },
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
  assets?: unknown;
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
      case "canvas/assets":
        return b.assets ?? { cards: [], canvases: b.rows.length, unreadable: [] };
      case "canvas/stat":
        return { mtime: 100 };
      case "canvas/write":
        return { id: params!.id, mtime: 200 };
      case "canvas/create":
        b.rows.push({
          id: params!.id as string,
          title: params!.title as string,
          parent: (params!.parent as string | undefined) ?? null,
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

  describe("nesting", () => {
    const tree = (): Backend => ({
      readOnly: false,
      rows: [
        { id: "world", title: "World", parent: null, error: null },
        { id: "world/ward-b", title: "Ward B", parent: "world", error: null },
      ],
      reads: { world: scene(2), "world/ward-b": scene(1, "Ward B") },
    });

    it("opens the child when a linked frame is double-clicked, and the breadcrumb returns", async () => {
      fake(tree());
      render(<App />);
      expect(await screen.findByText("2 elements")).toBeTruthy();
      expect(screen.queryByLabelText("Canvas path")).toBeNull();

      fireEvent.click(screen.getByText("double-click linked frame"));
      expect(await screen.findByText("1 elements")).toBeTruthy();
      const crumbs = screen.getByLabelText("Canvas path");
      expect(crumbs.textContent).toContain("World");
      expect(crumbs.textContent).toContain("Ward B");

      fireEvent.click(screen.getByText("World", { selector: "button" }));
      expect(await screen.findByText("2 elements")).toBeTruthy();
    });

    it("says so, and stays put, when the linked canvas is not in the checkout", async () => {
      fake(tree());
      render(<App />);
      await screen.findByText("2 elements");
      fireEvent.click(screen.getByText("double-click dangling frame"));
      expect(await screen.findByText(/"world\/ghost" does not exist/)).toBeTruthy();
      expect(screen.getByText("2 elements")).toBeTruthy();
    });

    it("creates a child canvas for a selected frame, saves the link, then opens it", async () => {
      const backend: Backend = {
        readOnly: false,
        rows: [{ id: "world", title: "World", parent: null, error: null }],
        reads: { world: scene(1) },
      };
      fake(backend);
      render(<App />);
      await screen.findByText("1 elements");
      fireEvent.click(screen.getByText("select frame"));
      fireEvent.click(await screen.findByText("Create child canvas"));

      await waitFor(() =>
        expect(bridge.invoke).toHaveBeenCalledWith("canvas/create", {
          id: "world/ward-b",
          title: "Ward B",
          parent: "world",
        }),
      );
      const write = bridge.invoke.mock.calls.find((c) => c[0] === "canvas/write");
      expect(write).toBeTruthy();
      const linked = (write![1].scene.elements as { id: string; customData?: unknown }[]).find(
        (e) => e.id === "f1",
      );
      expect(linked?.customData).toEqual({ kaava: { child: "world/ward-b" } });
      const order = bridge.invoke.mock.calls.map((c) => c[0]);
      expect(order.indexOf("canvas/create")).toBeLessThan(order.indexOf("canvas/write"));
      expect(await screen.findByLabelText("Canvas path")).toBeTruthy();
    });

    it("offers no linking on read-only main, but still opens an existing link", async () => {
      fake({ ...tree(), readOnly: true });
      render(<App />);
      await screen.findByText("2 elements");
      fireEvent.click(screen.getByText("select frame"));
      expect(screen.queryByText("Create child canvas")).toBeNull();
    });
  });

  describe("spec cards", () => {
    const one = (): Backend => ({
      readOnly: false,
      rows: [{ id: "world", title: "World", parent: null, error: null }],
      reads: { world: scene(1) },
    });

    it("saves a filled card on the selected element, and refuses an empty one", async () => {
      fake(one());
      render(<App />);
      await screen.findByText("1 elements");
      fireEvent.click(screen.getByText("select frame"));
      await screen.findByText("Make a spec card");

      fireEvent.click(screen.getByText("Save card"));
      expect(bridge.invoke.mock.calls.some((c) => c[0] === "canvas/write")).toBe(false);
      expect(await screen.findByText("A name is required.")).toBeTruthy();

      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Gurney" } });
      fireEvent.change(screen.getByLabelText("Size (m, largest side)"), {
        target: { value: "2" },
      });
      fireEvent.change(screen.getByLabelText("Triangle budget"), { target: { value: "8000" } });
      fireEvent.change(screen.getByLabelText("Review state"), { target: { value: "review" } });
      fireEvent.click(screen.getByText("Save card"));

      await waitFor(() => {
        const write = bridge.invoke.mock.calls.find((c) => c[0] === "canvas/write");
        expect(write).toBeTruthy();
        const el = (write![1].scene.elements as { id: string; customData?: unknown }[]).find(
          (e) => e.id === "f1",
        );
        expect(el?.customData).toEqual({
          kaava: {
            spec: {
              name: "Gurney",
              reference_images: [],
              size_m: 2,
              triangle_budget: 8000,
              style_notes: "",
              status: "review",
            },
          },
        });
      });
    });

    it("shows the exported JSON for a valid card", async () => {
      fake(one());
      render(<App />);
      await screen.findByText("1 elements");
      fireEvent.click(screen.getByText("select frame"));
      fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Gurney" } });
      fireEvent.change(screen.getByLabelText("Size (m, largest side)"), {
        target: { value: "2" },
      });
      fireEvent.change(screen.getByLabelText("Triangle budget"), { target: { value: "8000" } });
      const json = screen.getByLabelText("Exported JSON").textContent ?? "";
      expect(JSON.parse(json)).toMatchObject({ name: "Gurney", size_m: 2, triangle_budget: 8000 });
    });

    it("offers no editing on read-only main", async () => {
      fake({ ...one(), readOnly: true });
      render(<App />);
      await screen.findByText("1 elements");
      fireEvent.click(screen.getByText("select frame"));
      expect(screen.queryByText("Make a spec card")).toBeNull();
    });
  });

  describe("asset list", () => {
    const withCards = (): Backend => ({
      readOnly: false,
      rows: [
        { id: "world", title: "World", parent: null, error: null },
        { id: "world/ward-b", title: "Ward B", parent: "world", error: null },
      ],
      reads: { world: scene(2), "world/ward-b": scene(1, "Ward B") },
      assets: {
        canvases: 2,
        unreadable: [],
        cards: [
          {
            canvas: "world",
            canvasTitle: "World",
            elementId: "a",
            status: "accepted",
            spec: { name: "Chair", size_m: 1, triangle_budget: 500 },
          },
          {
            canvas: "world/ward-b",
            canvasTitle: "Ward B",
            elementId: "b",
            status: "review",
            spec: { name: "Gurney", size_m: 2, triangle_budget: 8000 },
          },
        ],
      },
    });

    it("lists every card across canvases with its state, and filters", async () => {
      fake(withCards());
      render(<App />);
      await screen.findByText("2 elements");
      fireEvent.click(screen.getByRole("tab", { name: "Asset list" }));
      expect(await screen.findByText("Gurney")).toBeTruthy();
      expect(screen.getByText("Chair")).toBeTruthy();
      expect(screen.getByRole("button", { name: "All 2" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "review 1" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "review 1" }));
      expect(screen.queryByText("Chair")).toBeNull();
      expect(screen.getByText("Gurney")).toBeTruthy();
    });

    it("opens the canvas a card is on", async () => {
      fake(withCards());
      render(<App />);
      await screen.findByText("2 elements");
      fireEvent.click(screen.getByRole("tab", { name: "Asset list" }));
      await screen.findByText("Gurney");
      fireEvent.click(screen.getByText("Ward B", { selector: "td button" }));
      expect(await screen.findByText("1 elements")).toBeTruthy();
      expect(screen.queryByLabelText("Asset list")).toBeNull();
    });

    it("says so when there are no cards, and names a canvas it could not read", async () => {
      const b = withCards();
      b.assets = { canvases: 1, unreadable: ["broken"], cards: [] };
      fake(b);
      render(<App />);
      await screen.findByText("2 elements");
      fireEvent.click(screen.getByRole("tab", { name: "Asset list" }));
      expect(await screen.findByText(/No spec cards yet/)).toBeTruthy();
      expect(screen.getByText(/Could not read broken/)).toBeTruthy();
    });
  });
});
