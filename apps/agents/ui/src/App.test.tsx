// @vitest-environment jsdom
/**
 * The app rendered against a stubbed bridge: what it opens on, what Start
 * does, and what a signed-out answer draws. `pnpm dev:agent` has no backend,
 * so this is where the wiring between the calls and the rail is checked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import transcriptText from "../../../../src-tauri/fixtures/cloud/veistra-prod-sessions/kaava-worker/3f2a9c1e-7b40-4d2a-9e61-0c5d8b7a1f01/transcript.jsonl?raw";
import type { Machine, Overview, Session } from "./rpc";

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

import App from "./App";

const recent = new Date(Date.now() - 60_000).toISOString();

const machine = (name: string, status: string): Machine => ({
  name,
  zone: "us-central1-a",
  status,
  machineType: "e2-standard-8",
  role: "agent",
  lastStart: null,
  lastStop: null,
});

const live: Session = {
  agent: "kaava-worker",
  sessionId: "3f2a9c1e-7b40-4d2a-9e61-0c5d8b7a1f01",
  statusGeneration: 1,
  written: recent,
  status: {
    state: "idle",
    updated: recent,
    workflow: { name: "asset-build", run: "chair-test-v2", step: "model" },
  },
  transcript: { name: "t", generation: 7, updated: recent, size: 100 },
};

const OVERVIEW: Overview = {
  source: "fixture",
  project: "veistra-prod",
  machines: [machine("kaava-worker", "RUNNING"), machine("kaava-worker-2", "TERMINATED")],
  sessions: [live],
  problems: [],
};

function backend(overview: Overview = OVERVIEW) {
  bridge.invoke.mockImplementation((method: string) => {
    switch (method) {
      case "agents/overview":
        return Promise.resolve(overview);
      case "agents/transcript":
        return Promise.resolve({
          generation: 7,
          size: transcriptText.length,
          updated: recent,
          unchanged: false,
          text: transcriptText,
          truncated: false,
        });
      case "agents/start":
        return Promise.resolve({ started: "kaava-worker-2" });
      default:
        return Promise.reject(new Error(`unexpected ${method}`));
    }
  });
}

afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

describe("Agents", () => {
  it("opens on the live session and titles it from its transcript", async () => {
    backend();
    render(<App />);
    // The session has no `prompt`, so the heading falls back to the first request.
    expect(
      await screen.findByRole("heading", { level: 2, name: /^Build the chair from spec/ }),
    ).toBeTruthy();
    expect(screen.getByText("asset-build · run chair-test-v2 · step model")).toBeTruthy();
    expect(screen.getAllByText("Bash").length).toBe(2);
  });

  it("starts a stopped machine only after a second press", async () => {
    backend();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    expect(bridge.invoke).not.toHaveBeenCalledWith("agents/start", expect.anything());
    expect(screen.getByText(/Bills e2-standard-8/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith("agents/start", { name: "kaava-worker-2" }),
    );
  });

  it("shows the fix, not a stack of errors, when gcloud is signed out", async () => {
    bridge.invoke.mockImplementation(() =>
      Promise.reject(
        new bridge.KaavaRpcError(-32603, "signed out", { kind: "signedOut", detail: "x" }),
      ),
    );
    render(<App />);
    expect(await screen.findByText("Signed out of Google Cloud")).toBeTruthy();
  });

  it("regroups by workflow run", async () => {
    backend();
    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: "Workflows" }));
    expect(screen.getByText("asset-build · chair-test-v2")).toBeTruthy();
  });

  it("waits with a note while the first read is pending, with no error yet", async () => {
    bridge.invoke.mockImplementation(() => new Promise(() => {}));
    render(<App />);
    expect(await screen.findByText(/Reading the project/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("ends the wait in a timed-out state with Retry when the bridge gives up", async () => {
    bridge.invoke.mockImplementation(() =>
      Promise.reject(new bridge.KaavaRpcError(-32001, "request timed out")),
    );
    render(<App />);
    expect(await screen.findByText("Reading Agents timed out")).toBeTruthy();
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
