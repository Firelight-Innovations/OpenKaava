// @vitest-environment jsdom
/**
 * The agent tab end to end against a scripted bridge: attach, live envelopes,
 * sending, approvals, refusals, and the mode.
 */
import "./jsdom-shims";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
  return {
    invoke: vi.fn(),
    listeners: new Map<string, (payload: unknown) => void>(),
    KaavaRpcError,
  };
});

vi.mock("@openkaava/bridge", () => ({
  invoke: bridge.invoke,
  on: (event: string, cb: (payload: unknown) => void) => {
    bridge.listeners.set(event, cb);
    return () => bridge.listeners.delete(event);
  },
  reportPainted: vi.fn(),
  KaavaRpcError: bridge.KaavaRpcError,
}));

import App from "./App";
import { strings } from "./strings";
import type { Attachment, Envelope, Item, SessionStatus } from "./protocol.generated";

const STATUS: SessionStatus = {
  state: "ready",
  harness: "claude",
  cwd: "C:/work/feature-x",
  mode: "default",
  modes: [],
  config: [],
  answered: 0,
  settingTrouble: null,
  adapterVersion: "0.90.0",
  exitCode: null,
  hint: null,
  pendingPrompt: null,
};

const choice = (value: string, name: string) => ({ value, name, description: null });

/** A session with Claude's three modes. */
const SETTINGS: SessionStatus = {
  ...STATUS,
  modes: [
    choice("default", "Manual"),
    choice("acceptEdits", "Accept edits"),
    choice("plan", "Plan"),
  ],
};

function item(id: string, kind: Item["kind"]): Item {
  return { id, turnId: "t1", kind };
}

function backend(attachment: Attachment, overrides: Record<string, () => Promise<unknown>> = {}) {
  let ticket = 0;
  bridge.invoke.mockImplementation((method: string) => {
    const override = overrides[method];
    if (override) return override();
    switch (method) {
      case "agent-tab/attach":
        return Promise.resolve(attachment);
      case "agent-tab/harnesses":
        return Promise.resolve({ harnesses: [{ harness: "claude", hint: null }], blocked: null });
      case "agent-tab/set-mode":
        return Promise.resolve({ ticket: ++ticket });
      default:
        return Promise.resolve({});
    }
  });
}

function emit(envelope: Envelope) {
  act(() => bridge.listeners.get("agent-tab:event")?.(envelope));
}

function prompt() {
  return screen.getByRole("textbox", { name: "Message the agent" });
}

/** The settings button, which reads out every setting it shows. */
async function settingsButton() {
  return screen.findByRole("button", { name: /^Agent settings/ });
}

/** The mode the settings button shows, by name. */
async function shownMode() {
  const label = (await settingsButton()).getAttribute("aria-label") ?? "";
  return label.split(", ").at(-1);
}

/** The settings menu's Mode group, opened. */
async function modeMenu() {
  fireEvent.click(await settingsButton());
  return within(await screen.findByRole("group", { name: "Mode" }));
}

beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.listeners.clear();
});
afterEach(cleanup);

describe("the agent tab", () => {
  it("draws the attached transcript, then applies only newer events", async () => {
    backend({
      status: STATUS,
      seq: 5,
      items: [item("u1", { kind: "userMessage", text: "list the files" })],
    });
    render(<App />);
    await screen.findByText("list the files");

    emit({
      instanceId: "i",
      seq: 4,
      event: { type: "itemStarted", item: item("a0", { kind: "assistantText", text: "stale" }) },
    });
    emit({
      instanceId: "i",
      seq: 6,
      event: { type: "itemStarted", item: item("a1", { kind: "assistantText", text: "Here" }) },
    });
    emit({
      instanceId: "i",
      seq: 7,
      event: { type: "itemDelta", itemId: "a1", text: " they are" },
    });

    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.getByText("Here they are")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Ready");
  });

  it("sends on Enter as Claude and clears the prompt", async () => {
    backend({ status: null, seq: 0, items: [] });
    render(<App />);
    await screen.findByText("Start a session");
    fireEvent.change(prompt(), { target: { value: "fix the test" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", {
      harness: "claude",
      text: "fix the test",
    });
    expect(prompt()).toHaveProperty("value", "");
  });

  it("shows a refusal and its hint in the tab's own words", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/send": () =>
          Promise.reject(
            new bridge.KaavaRpcError(-32010, "x", { code: "harness", hint: "adapterMissing" }),
          ),
      },
    );
    render(<App />);
    await screen.findByText("Start a session");
    fireEvent.change(prompt(), { target: { value: "go" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Claude is not ready to run.");
    expect(alert.textContent).toContain("claude-agent-acp@0.90.0");
    expect(prompt()).toHaveProperty("value", "go");
  });

  it("words the harness's setup hint in the empty state", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/harnesses": () =>
          Promise.resolve({ harnesses: [{ harness: "claude", hint: "signedOut" }], blocked: null }),
      },
    );
    render(<App />);
    expect(await screen.findByText(strings.hint.signedOut)).toBeTruthy();
  });

  it("words an error item's hint inside the error", async () => {
    backend({
      status: STATUS,
      seq: 2,
      items: [item("e1", { kind: "error", message: "boom", hint: "harnessMissing" })],
    });
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
    expect(alert.textContent).toContain(strings.hint.harnessMissing);
  });

  it("says a main checkout is why, when the shell refuses the write before the tab's own code", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/send": () =>
          Promise.reject(new bridge.KaavaRpcError(-32003, "main is read-only")),
      },
    );
    render(<App />);
    await screen.findByText("Start a session");
    fireEvent.change(prompt(), { target: { value: "go" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("main checkout");
    expect(alert.textContent).not.toContain("Could not send that.");
    expect(prompt()).toHaveProperty("value", "go");
  });

  it("answers an approval with the option clicked", async () => {
    backend({
      status: { ...STATUS, state: "needsInput" },
      seq: 3,
      items: [
        item("p1", {
          kind: "approval",
          title: "Run npm test",
          toolCallId: "c1",
          detail: "npm test",
          detailTruncated: false,
          paths: [],
          diffs: [],
          options: [
            { optionId: "allow", kind: "allow_once", name: "Allow" },
            { optionId: "reject", kind: "reject_once", name: "Reject" },
          ],
          answer: null,
        }),
      ],
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/answer", {
        itemId: "p1",
        optionId: "allow",
      }),
    );
    expect(screen.getByRole("button", { name: "Reject" })).toHaveProperty("disabled", true);
  });

  it("lets an approval be answered again when the answer did not land", async () => {
    backend(
      {
        status: { ...STATUS, state: "needsInput" },
        seq: 3,
        items: [
          item("p1", {
            kind: "approval",
            title: "Run npm test",
            toolCallId: "c1",
            detail: "npm test",
            detailTruncated: false,
            paths: [],
            diffs: [],
            options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
            answer: null,
          }),
        ],
      },
      { "agent-tab/answer": () => Promise.reject(new Error("gone")) },
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Allow" })).toHaveProperty("disabled", false),
    );
  });

  it("retries the prompt the error answered, and keeps what is being typed", async () => {
    backend({
      status: STATUS,
      seq: 4,
      items: [
        item("u1", { kind: "userMessage", text: "fix the build" }),
        item("e2", { kind: "error", message: "overloaded", hint: null }),
      ],
    });
    render(<App />);
    await screen.findByText("fix the build");
    fireEvent.change(prompt(), { target: { value: "half typed" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", {
      harness: "claude",
      text: "fix the build",
    });
    expect(prompt()).toHaveProperty("value", "half typed");
  });

  it("offers to attach again when the first attach fails", async () => {
    let attempts = 0;
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/attach": () =>
          ++attempts === 1
            ? Promise.reject(new Error("not yet"))
            : Promise.resolve({
                status: STATUS,
                seq: 2,
                items: [item("u1", { kind: "userMessage", text: "back again" })],
              }),
      },
    );
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not reach the agent host.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await screen.findByText("back again");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("turns Send into Stop while the agent works, and Esc cancels the turn", async () => {
    backend({ status: { ...STATUS, state: "working" }, seq: 1, items: [] });
    render(<App />);
    await screen.findByRole("button", { name: "Stop" });
    fireEvent.keyDown(prompt(), { key: "Escape" });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/cancel");
  });

  it("puts a hover card away with Esc before Esc stops the turn", async () => {
    backend({
      status: { ...STATUS, state: "working" },
      seq: 2,
      items: [
        item("u1", { kind: "userMessage", text: "go" }),
        item("g1", { kind: "usage", used: 10, size: 100 }),
      ],
    });
    render(<App />);
    const meter = await screen.findByRole("button", { name: "Context window 10% full" });
    fireEvent.pointerEnter(meter.parentElement!);
    const card = screen.getByRole("tooltip", { hidden: true });
    expect(card.hasAttribute("data-open")).toBe(true);

    prompt().focus();
    fireEvent.keyDown(prompt(), { key: "Escape" });
    expect(card.hasAttribute("data-open")).toBe(false);
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/cancel");

    fireEvent.keyDown(prompt(), { key: "Escape" });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/cancel");
  });

  it("shows the accepted prompt while the agent starts, and Stop and Esc withdraw it", async () => {
    backend({
      status: { ...STATUS, state: "starting", pendingPrompt: "fix the build" },
      seq: 2,
      items: [],
    });
    render(<App />);
    await screen.findByText("fix the build");
    expect(screen.getByText(/Your message is sent once it is ready/)).toBeTruthy();
    expect(screen.queryByText("Start a session")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/cancel");
    bridge.invoke.mockClear();
    fireEvent.keyDown(prompt(), { key: "Escape" });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/cancel");
  });

  it("retries a prompt whose handshake failed, with that prompt and not an older one", async () => {
    backend({
      status: { ...STATUS, state: "failed", hint: "signedOut" },
      seq: 9,
      items: [
        item("u1", { kind: "userMessage", text: "an older prompt" }),
        item("u2", { kind: "userMessage", text: "the one that failed" }),
        item("e2", { kind: "error", message: "authentication required", hint: "signedOut" }),
      ],
    });
    render(<App />);
    await screen.findByText("the one that failed");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", {
      harness: "claude",
      text: "the one that failed",
    });
  });

  it("groups the transcript into turns, and says it is working before the first reply", async () => {
    backend({
      status: { ...STATUS, state: "working" },
      seq: 2,
      items: [item("u1", { kind: "userMessage", text: "list the files" })],
    });
    const { container } = render(<App />);
    await screen.findByText("list the files");
    expect(screen.getByText("Working…")).toBeTruthy();

    emit({
      instanceId: "i",
      seq: 3,
      event: { type: "itemStarted", item: item("a1", { kind: "assistantText", text: "Here" }) },
    });
    emit({
      instanceId: "i",
      seq: 4,
      event: { type: "itemStarted", item: item("r1", { kind: "reasoning", text: "hmm" }) },
    });
    expect(screen.queryByText("Working…")).toBeNull();
    expect(container.querySelectorAll(".at-turn--user")).toHaveLength(1);
    const agent = container.querySelectorAll(".at-turn--agent");
    expect(agent).toHaveLength(1);
    expect(agent[0].textContent).toContain("Here");
  });

  it("says it is working after a tool row only while the turn runs", async () => {
    const tool = item("c1", {
      kind: "toolCall",
      title: "pnpm test",
      toolKind: "execute",
      status: "completed",
      output: "",
      truncated: false,
      paths: [],
      diffs: [],
    });
    const items = [item("u1", { kind: "userMessage", text: "run the tests" }), tool];
    backend({ status: STATUS, seq: 2, items });
    render(<App />);
    await screen.findByText("pnpm test");
    expect(screen.queryByText("Working…")).toBeNull();
    cleanup();

    backend({ status: { ...STATUS, state: "working" }, seq: 2, items });
    render(<App />);
    await screen.findByText("pnpm test");
    expect(screen.getByText("Working…")).toBeTruthy();
  });

  it("does not say it is working while the agent waits on an approval", async () => {
    backend({
      status: { ...STATUS, state: "needsInput" },
      seq: 2,
      items: [
        item("u1", { kind: "userMessage", text: "edit the file" }),
        item("p1", {
          kind: "approval",
          title: "Edit a.ts",
          toolCallId: "c1",
          detail: null,
          detailTruncated: false,
          paths: [],
          diffs: [],
          options: [{ optionId: "ok", kind: "allow_once", name: "Allow" }],
          answer: null,
        }),
      ],
    });
    render(<App />);
    await screen.findByRole("button", { name: "Allow" });
    expect(screen.queryByText("Working…")).toBeNull();
  });

  it("puts Copy on every finished agent turn, where the keyboard can reach it", async () => {
    backend({
      status: STATUS,
      seq: 4,
      items: [
        item("u1", { kind: "userMessage", text: "one" }),
        item("a1", { kind: "assistantText", text: "first answer" }),
        item("u2", { kind: "userMessage", text: "two" }),
        item("a2", { kind: "assistantText", text: "second answer" }),
      ],
    });
    render(<App />);
    await screen.findByText("first answer");
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(2);
  });

  it("keeps Copy on earlier turns while a turn runs, and leaves it off the one being written", async () => {
    const items = [
      item("u1", { kind: "userMessage", text: "one" }),
      item("a1", { kind: "assistantText", text: "first answer" }),
      item("u2", { kind: "userMessage", text: "two" }),
      item("a2", { kind: "assistantText", text: "half an answ" }),
    ];
    backend({ status: { ...STATUS, state: "working" }, seq: 4, items });
    const { container } = render(<App />);
    await screen.findByText("half an answ");
    const turns = container.querySelectorAll(".at-turn--agent");
    expect(turns[0].querySelector(".at-turn__actions")).not.toBeNull();
    expect(turns[1].querySelector(".at-turn__actions")).toBeNull();

    emit({ instanceId: "i", seq: 5, event: { type: "status", status: STATUS } });
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(2);
  });

  it("leaves Copy off a turn with no text, and says when it has copied", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      backend({
        status: STATUS,
        seq: 4,
        items: [
          item("u1", { kind: "userMessage", text: "one" }),
          item("e1", { kind: "error", message: "boom", hint: null }),
          item("u2", { kind: "userMessage", text: "two" }),
          item("a2", { kind: "assistantText", text: "an answer" }),
        ],
      });
      render(<App />);
      await screen.findByText("an answer");
      const copy = screen.getByRole("button", { name: "Copy" });
      await act(async () => {
        fireEvent.click(copy);
      });
      expect(writeText).toHaveBeenCalledWith("an answer");
      expect(copy.textContent).toBe("Copied");
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it("redraws no transcript item while a prompt is typed", async () => {
    const drawn = vi.fn();
    const { SlotsProvider } = await import("./components/registry");
    function CountingUserMessage({ text }: { text: string }) {
      drawn(text);
      return <p>{text}</p>;
    }
    backend({
      status: STATUS,
      seq: 2,
      items: [
        item("u1", { kind: "userMessage", text: "list the files" }),
        item("a1", { kind: "assistantText", text: "Here" }),
      ],
    });
    render(
      <SlotsProvider slots={{ UserMessage: CountingUserMessage }}>
        <App />
      </SlotsProvider>,
    );
    await screen.findByText("list the files");
    const before = drawn.mock.calls.length;
    for (const value of ["a", "ab", "abc"]) fireEvent.change(prompt(), { target: { value } });
    expect(drawn.mock.calls.length).toBe(before);
  });

  it("says when the mode will appear, and leaves Shift+Tab alone till then", async () => {
    backend({ status: null, seq: 0, items: [] });
    render(<App />);
    const menu = await modeMenu();
    const later = menu.getByRole("menuitemradio", {
      name: "The mode appears once the session starts.",
    });
    expect(later.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true });
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/set-mode", expect.anything());
  });

  it("switches mode with Shift+Tab, showing the choice until the agent answers it", async () => {
    backend({ status: SETTINGS, seq: 1, items: [] });
    render(<App />);
    expect(await shownMode()).toBe("Manual");
    const menu = await modeMenu();
    const labels = menu.getAllByRole("menuitemradio").map((o) => o.textContent);
    expect(labels).toEqual(["Manual", "Accept edits", "Plan"]);
    fireEvent.click(await settingsButton());
    const status = (seq: number, status: SessionStatus) =>
      emit({ instanceId: "i", seq, event: { type: "status", status } });

    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true });
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/set-mode", { modeId: "acceptEdits" });
    expect(await shownMode()).toBe("Accept edits");

    // A status about something else, such as a turn starting, answers
    // nothing: the choice stands, and the next press moves on from it.
    status(2, { ...SETTINGS, state: "working" });
    expect(await shownMode()).toBe("Accept edits");
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true });
    });
    expect(bridge.invoke).toHaveBeenLastCalledWith("agent-tab/set-mode", { modeId: "plan" });
    expect(await shownMode()).toBe("Plan");

    // The first answer leaves the second choice standing.
    status(3, { ...SETTINGS, mode: "acceptEdits", answered: 1 });
    expect(await shownMode()).toBe("Plan");

    // The agent has the last word.
    status(4, { ...SETTINGS, mode: "acceptEdits", answered: 2 });
    expect(await shownMode()).toBe("Accept edits");
  });

  it("changes the mode from the settings menu, and takes it back when refused", async () => {
    backend(
      { status: SETTINGS, seq: 1, items: [] },
      {
        "agent-tab/set-mode": () =>
          Promise.reject(
            new bridge.KaavaRpcError(-32010, "x", { code: "unknownOption", hint: null }),
          ),
      },
    );
    render(<App />);
    const menu = await modeMenu();
    await act(async () => {
      fireEvent.click(menu.getByRole("menuitemradio", { name: "Plan" }));
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/set-mode", { modeId: "plan" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The agent does not offer that choice.");
    expect(await shownMode()).toBe("Manual");
  });

  it("says a slow or refused change above the prompt, with nothing to retry", async () => {
    backend({
      status: SETTINGS,
      seq: 1,
      items: [item("u1", { kind: "userMessage", text: "list the files" })],
    });
    render(<App />);
    const status = (seq: number, status: SessionStatus) =>
      emit({ instanceId: "i", seq, event: { type: "status", status } });
    const menu = await modeMenu();
    await act(async () => {
      fireEvent.click(menu.getByRole("menuitemradio", { name: "Plan" }));
    });

    status(2, { ...SETTINGS, settingTrouble: { kind: "unanswered", ticket: 1 } });
    await screen.findByText(
      "The agent has not answered that change yet. Later changes wait for it.",
    );
    expect(await shownMode()).toBe("Plan");

    status(3, {
      ...SETTINGS,
      answered: 1,
      settingTrouble: { kind: "refused", ticket: 1, message: "not in this session" },
    });
    await screen.findByText("The agent refused that change: not in this session");
    expect(await shownMode()).toBe("Manual");
    // A setting is not a prompt: a Retry here would resend "list the files".
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    // Once the session ends there is nothing left to answer it.
    status(4, {
      ...SETTINGS,
      state: "stopped",
      answered: 1,
      settingTrouble: { kind: "refused", ticket: 1, message: "not in this session" },
    });
    expect(screen.queryByText(/The agent refused that change/)).toBeNull();
  });

  it("does not promise a mode to a session that failed before reporting one", async () => {
    backend({ status: { ...STATUS, state: "failed" }, seq: 1, items: [] });
    render(<App />);
    fireEvent.click(await settingsButton());
    expect(screen.queryByRole("group", { name: "Mode" })).toBeNull();
    expect(screen.queryByText("The mode appears once the session starts.")).toBeNull();
  });

  it("offers no mode while the session is stopped", async () => {
    backend({ status: { ...SETTINGS, state: "stopped" }, seq: 1, items: [] });
    render(<App />);
    const menu = await modeMenu();
    for (const item of menu.getAllByRole("menuitemradio")) {
      expect(item.getAttribute("aria-disabled")).toBe("true");
    }
  });

  it("shows a mode the agent entered but the tab does not offer, as it is", async () => {
    backend({ status: { ...SETTINGS, mode: "auto" }, seq: 1, items: [] });
    render(<App />);
    expect(await shownMode()).toBe("auto");
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true });
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/set-mode", { modeId: "default" });
  });

  it("never names the harness Claude Code", async () => {
    backend({ status: STATUS, seq: 1, items: [] });
    render(<App />);
    expect((await screen.findAllByText("Claude")).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("Claude Code");
  });
});
