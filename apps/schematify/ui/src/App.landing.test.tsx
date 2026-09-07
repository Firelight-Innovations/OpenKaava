// @vitest-environment jsdom
/**
 * What the app asks for on first paint.
 *
 * `LANDING_PATH` is pinned in `engine/navigation.test.ts`, but pinning the
 * constant is not the same as pinning the wiring: `useState(LANDING_PATH)`
 * could go back to a two-segment literal and every one of those cases would
 * still pass. This is the assertion that could not: it renders the real
 * component and reads the tier and slug that actually reach the seam.
 *
 * That is exactly what the defect was. `App.tsx` opened
 * `{ tier: "service", slug: "auth-service" }` for every project, so any
 * project but `crates/schematify-core/fixtures/saas-backend/` drew
 * `no service named "auth-service" in this project` over the whole shell —
 * unrecoverably, since the breadcrumb only walks a path you already have.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// jsdom implements no `ResizeObserver`, and `engine/SchematicCanvas.tsx`
// constructs one in an effect to feed the engine its size. A stub that never
// fires is the honest shape here: nothing in this file has a size, and
// `vitest.config.ts` already records that layout and hit-testing are what a
// jsdom test cannot do. The canvas mounts; it is simply never resized.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopResizeObserver);

// The bridge touches `window` and talks to Tauri; the seam below is where
// this test actually observes. `graph/backend.test.ts` covers what the real
// seam does with a tier — this file only asks which tier it is handed.
vi.mock("@openkaava/bridge", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("no backend in this test"))),
  KaavaRpcError: class KaavaRpcError extends Error {},
  reportPainted: vi.fn(),
}));

const loadGraph = vi.fn();

vi.mock("./graph", async (importOriginal) => {
  const real = await importOriginal<typeof import("./graph")>();
  return {
    ...real,
    defaultSeam: {
      ...real.defaultSeam,
      loadGraph: (...args: unknown[]) => {
        loadGraph(...args);
        // The seam behaves as the real one does for a project that is not the
        // fixture: a service target throws, in `projectServiceGraph`'s own
        // words. Without this the landing view could ask for any tier and the
        // assertions below would still pass, which is the shape of test that
        // passes for the wrong reason.
        const [tier, slug] = args as [string, string];
        if (tier !== "stack") {
          return Promise.reject(new Error(`no service named "${slug}" in this project`));
        }
        // A project with services, so the populated view renders rather than
        // the empty-stack one. Two services and no dependency edges is the
        // smallest thing tier 1 can honestly draw.
        return Promise.resolve({
          tier: "stack",
          serviceSlug: "stack",
          serviceTitle: "orchestrator",
          nodes: [
            { id: "s1", slug: "orchestrator-backend", title: "Backend", kind: "service" },
            { id: "s2", slug: "shell-frontend", title: "Shell", kind: "service" },
          ],
          edges: [],
        });
      },
      readLayout: () => Promise.resolve(null),
    },
    fetchLintReport: () => Promise.resolve({ findings: [] }),
    fetchRuns: () => Promise.resolve({ runs: [] }),
  };
});

const { default: App } = await import("./App");

afterEach(() => {
  cleanup();
  loadGraph.mockReset();
});

describe("the Schematify landing view", () => {
  it("opens the stack tier, naming no service the project has to contain", async () => {
    render(<App />);
    await waitFor(() => expect(loadGraph).toHaveBeenCalled());
    const [tier] = loadGraph.mock.calls[0] as [string, string];
    expect(tier).toBe("stack");
  });

  it("draws the project's services rather than an error", async () => {
    render(<App />);
    // The exact string the defect drew, for every project but one fixture.
    await waitFor(() => expect(screen.getByText("Stack")).toBeDefined());
    expect(screen.queryByText(/no service named/)).toBeNull();
  });

  it("reports the count off the graph it was given, not off a fixture", async () => {
    render(<App />);
    // `stackHeaderCounts`, the tier-1 header. The status bar and the Outline
    // footer say `2 services` too, from the same projection — asserting the
    // header's exact string keeps this about the number rather than about
    // which of the three happens to be found first.
    await waitFor(() => expect(screen.getByText("2 services · 0 dependency edges")).toBeDefined());
  });
});
