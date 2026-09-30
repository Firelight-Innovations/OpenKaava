// @vitest-environment jsdom
/**
 * The app rendered against a stubbed bridge: the project list, the empty
 * state, a malformed record surfacing as a problem rather than hiding the
 * rest, and the wake flow's "Starting Plane… Ns" label. `pnpm dev:agent` has
 * no backend, so this is where the wiring between the calls and the panes is
 * checked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProjectRecord, ProjectsList, WakeSnapshot } from "./rpc";

// jsdom implements no `ResizeObserver` — see
// `apps/schematify/ui/src/App.landing.test.tsx` for the same stub and why a
// no-op is the honest shape in a test with no real layout to observe.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopResizeObserver);

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
  // The real shell reports this moments after the iframe mounts. Answering it
  // synchronously here stands in for that, rather than making every test that
  // exercises the wake flow also drive a fake `kaava/window-rect` message —
  // `frameRect.test.ts` is where the combining logic itself is covered.
  on: vi.fn((event: string, cb: (payload: unknown) => void) => {
    if (event === "kaava/window-rect") cb({ x: 10, y: 20, width: 300, height: 300 });
    return () => {};
  }),
}));

import App from "./App";

const record = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  schema: 1,
  slug: "anomaly",
  name: "Anomaly",
  game: "anomaly",
  plane: { workspace: "veistra", project_id: "abc-123", identifier: "ANOM" },
  artifacts: "gs://veistra-artifacts/anomaly/",
  repo: null,
  hindsight_banks: [],
  created: "2026-09-28T00:00:00Z",
  archived: false,
  ...over,
});

const LIST: ProjectsList = {
  source: "fixture",
  profile: "prod",
  projects: [record()],
  problems: [],
};

function backend(opts: { list?: ProjectsList; wake?: WakeSnapshot[] } = {}): {
  wakeStatusCalls: () => number;
} {
  const wakeSteps = [...(opts.wake ?? [{ phase: "healthy", elapsedSeconds: 1.2 }])];
  let wakeCalls = 0;
  bridge.invoke.mockImplementation((method: string) => {
    switch (method) {
      case "projects/list":
        return Promise.resolve(opts.list ?? LIST);
      case "projects/hosts-check":
        return Promise.resolve({ ok: true, resolved: "127.0.0.1", fix: null });
      case "projects/wake-start":
        return Promise.resolve({ started: true });
      case "projects/wake-status": {
        wakeCalls += 1;
        const step = wakeSteps[Math.min(wakeCalls - 1, wakeSteps.length - 1)];
        return Promise.resolve(step);
      }
      case "projects/wake-cancel":
        return Promise.resolve({ cancelled: true });
      case "projects/webview-open":
        return Promise.resolve({ opened: true });
      case "projects/webview-bounds":
        return Promise.resolve({ moved: true });
      case "projects/webview-close":
        return Promise.resolve({ closed: true });
      default:
        return Promise.reject(new Error(`unexpected ${method}`));
    }
  });
  return { wakeStatusCalls: () => wakeCalls };
}

afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

describe("Projects", () => {
  it("lists projects from the fixture bucket, labelled as such", async () => {
    backend();
    render(<App />);
    expect(await screen.findByText("Anomaly")).toBeTruthy();
    expect(screen.getByText("fixture")).toBeTruthy();
    expect(screen.getByText("ANOM")).toBeTruthy();
  });

  it("shows a project's own problem without hiding the rest of the list", async () => {
    backend({
      list: {
        source: "fixture",
        profile: "prod",
        projects: [record()],
        problems: ["broken.json: expected value at line 1 column 1"],
      },
    });
    render(<App />);
    expect(await screen.findByText("Anomaly")).toBeTruthy();
    expect(screen.getByText(/broken\.json/)).toBeTruthy();
  });

  it("shows the empty state when the bucket has no projects yet", async () => {
    backend({ list: { source: "live", profile: "prod", projects: [], problems: [] } });
    render(<App />);
    expect(await screen.findByText(/No projects yet/)).toBeTruthy();
  });

  it("selecting a project starts the wake flow and reports progress", async () => {
    backend({
      wake: [
        { phase: "waking", elapsedSeconds: 3, detail: "plane-vm is TERMINATED" },
        { phase: "healthy", elapsedSeconds: 9.5 },
      ],
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Anomaly/ }));
    expect(await screen.findByText(/Starting Plane… 3s/)).toBeTruthy();
    expect(screen.getByText(/plane-vm is TERMINATED/)).toBeTruthy();
    await waitFor(
      () =>
        expect(bridge.invoke).toHaveBeenCalledWith(
          "projects/webview-open",
          expect.objectContaining({ url: expect.stringContaining("abc-123") }),
        ),
      // The second `wake-status` (the one answering "healthy") arrives on
      // this app's own 1 s poll tick, not synchronously like the first —
      // see `App.tsx`'s `WAKE_POLL_MS` — so the default 1 s `waitFor`
      // window is exactly as long as the thing it is waiting for.
      { timeout: 3000 },
    );
  });

  it("the Cancel button asks the backend to cancel the wake", async () => {
    backend({ wake: [{ phase: "waking", elapsedSeconds: 1, detail: "checking plane-vm" }] });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Anomaly/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("projects/wake-cancel"));
  });

  it("shows the hosts-file fix without blocking the wake flow", async () => {
    backend();
    bridge.invoke.mockImplementation((method: string) => {
      if (method === "projects/list") return Promise.resolve(LIST);
      if (method === "projects/hosts-check") {
        return Promise.resolve({
          ok: false,
          resolved: "203.0.113.5",
          fix: 'Add "127.0.0.1 plane.kaava.internal" to the hosts file (as an administrator, once).',
        });
      }
      if (method === "projects/wake-start") return Promise.resolve({ started: true });
      if (method === "projects/wake-status")
        return Promise.resolve({ phase: "healthy", elapsedSeconds: 1 });
      if (method === "projects/webview-open") return Promise.resolve({ opened: true });
      return Promise.reject(new Error(`unexpected ${method}`));
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Anomaly/ }));
    expect(await screen.findByText(/Add "127.0.0.1 plane.kaava.internal"/)).toBeTruthy();
  });

  it("waits with a note while the first read is pending, with no error yet", async () => {
    bridge.invoke.mockImplementation(() => new Promise(() => {}));
    render(<App />);
    expect(await screen.findByText(/Reading the project list/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("ends the wait in a timed-out state with Retry when the bridge gives up", async () => {
    bridge.invoke.mockImplementation(() =>
      Promise.reject(new bridge.KaavaRpcError(-32001, "request timed out")),
    );
    render(<App />);
    expect(await screen.findByText("Reading Projects timed out")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("says which account to check when Google Cloud denies the read", async () => {
    bridge.invoke.mockImplementation(() =>
      Promise.reject(new bridge.KaavaRpcError(-32603, "refused", { kind: "denied", detail: "no" })),
    );
    render(<App />);
    expect(await screen.findByText("This Google account may not read that")).toBeTruthy();
    expect(screen.getByText("gcloud auth list")).toBeTruthy();
  });

  it("tells you to install the CLI when gcloud is missing", async () => {
    bridge.invoke.mockImplementation(() =>
      Promise.reject(new bridge.KaavaRpcError(-32603, "no gcloud", { kind: "gcloudMissing" })),
    );
    render(<App />);
    expect(await screen.findByText("The Google Cloud CLI is not installed")).toBeTruthy();
  });
});
