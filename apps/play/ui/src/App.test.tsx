// @vitest-environment jsdom
/**
 * Play's send actions live in the shared footer, and still call the same
 * `context/put` the buttons used to: the log tail, and the captured frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@openkaava/bridge", () => ({
  invoke: bridge.invoke,
  reportPainted: vi.fn(),
  openIn: vi.fn(),
}));

import App from "./App";

const RUN = {
  id: 1,
  pid: 10,
  state: { kind: "running" },
  startedAt: 0,
  endedAt: null,
  scene: "res://main.tscn",
  project: ".",
  paused: false,
  captureReady: true,
};

function backend(putResult: () => unknown = () => ({ key: "k" })) {
  bridge.invoke.mockImplementation((method: string) => {
    switch (method) {
      case "play/state":
        return Promise.resolve({
          run: RUN,
          log: {
            lines: [{ seq: 1, stream: "stdout", level: "info", text: "hello", at: 0 }],
            nextSeq: 2,
            truncated: false,
          },
        });
      case "godot/status":
        return Promise.resolve({
          environment: { root: "C:/p", readOnly: false },
          executable: { found: null, problems: [], setting: "" },
          projects: [],
        });
      case "comments/list":
        return Promise.resolve([]);
      case "play/capture":
        return Promise.resolve({
          png: "AAAA",
          width: 1,
          height: 1,
          time: 3,
          scene: "res://main.tscn",
        });
      case "context/put":
        return Promise.resolve(putResult());
      default:
        return Promise.resolve(null);
    }
  });
}

const puts = () => bridge.invoke.mock.calls.filter((c) => c[0] === "context/put");

beforeEach(() => {
  bridge.invoke.mockReset();
  // jsdom has no layout, so no scrollIntoView; the log pane calls it.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("Play send footer", () => {
  it("sends the log tail from the footer and says Sent", async () => {
    backend();
    const { container } = render(<App />);
    const button = await screen.findByRole("button", { name: "Send log" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(container.querySelector(".k-send-footer")?.contains(button)).toBe(true);
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Sent" });
    expect(puts()).toHaveLength(1);
    expect(puts()[0][1]).toMatchObject({ kind: "text", label: "Play - game output" });
  });

  it("offers Send frame in the footer once a frame is captured, not in the composer", async () => {
    backend();
    const { container } = render(<App />);
    expect(screen.queryByRole("button", { name: "Send frame" })).toBeNull();
    const capture = await screen.findByRole("button", { name: /Capture & comment/ });
    await waitFor(() => expect((capture as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(capture);
    const send = await screen.findByRole("button", { name: "Send frame" });
    expect(container.querySelector(".k-send-footer")?.contains(send)).toBe(true);
    expect(container.querySelector(".pl__composer")?.contains(send)).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0][1]).toMatchObject({ kind: "panel", bytesBase64: "AAAA" });
  });

  it("names what failed to send", async () => {
    backend(() => {
      throw new Error("no store");
    });
    render(<App />);
    const button = await screen.findByRole("button", { name: "Send log" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByText(/Couldn't send log to the agent/);
  });
});
