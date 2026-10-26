// @vitest-environment jsdom
/**
 * The agent tab end to end against a scripted bridge: attach, live envelopes,
 * sending, approvals, refusals, the mode, the model and the effort.
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
import type {
  Attachment,
  ConfigOption,
  Envelope,
  HarnessInfo,
  Item,
  SessionStatus,
} from "./protocol.generated";

/** Claude as `agent-tab/harnesses` describes it, from `harness/claude.rs`. */
const CLAUDE: HarnessInfo = {
  harness: "claude",
  name: "Claude",
  hint: null,
  setup: {
    cli: "claude",
    signIn: "claude",
    adapterInstall: "npm i -g --omit=optional @agentclientprotocol/claude-agent-acp@0.90.0",
    adapterVersion: "0.90.0",
  },
  capabilities: { steer: false, fork: false, modes: false },
  models: null,
  model: null,
};

/** Codex as `agent-tab/harnesses` describes it, from `harness/codex.rs`. */
const CODEX: HarnessInfo = {
  harness: "codex",
  name: "Codex",
  hint: null,
  setup: {
    cli: "codex",
    signIn: "codex login",
    adapterInstall: "npm i -g --omit=optional @agentclientprotocol/codex-acp@2.2.2",
    adapterVersion: "2.2.2",
  },
  capabilities: { steer: false, fork: false, modes: false },
  models: null,
  model: null,
};

const STATUS: SessionStatus = {
  state: "ready",
  harness: "claude",
  cwd: "C:/work/feature-x",
  mode: "default",
  modes: [],
  config: [],
  answered: 0,
  settingTrouble: null,
  commands: [],
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

const option = (
  id: string,
  name: string,
  category: string,
  value: string,
  choices: [string, string][],
): ConfigOption => ({
  id,
  name,
  description: null,
  category,
  value,
  choices: choices.map(([v, n]) => choice(v, n)),
});

const LEVELS: [string, string][] = [
  ["default", "Default"],
  ["low", "Low"],
  ["high", "High"],
];

/** Claude's options as the adapter lists them for its default model. */
const MODELS: SessionStatus = {
  ...SETTINGS,
  config: [
    option("model", "Model", "model", "default", [
      ["default", "Default (recommended)"],
      ["opus", "Opus"],
      ["haiku", "Haiku"],
    ]),
    option("effort", "Effort", "thought_level", "default", LEVELS),
    option("fast", "Fast mode", "model_config", "off", [
      ["off", "Off"],
      ["on", "On"],
    ]),
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
        return Promise.resolve({ harnesses: [CLAUDE], current: "claude", blocked: null });
      case "agent-tab/set-mode":
      case "agent-tab/set-config":
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

/** What the settings button shows, in order: harness, model, effort, mode. */
async function shown() {
  const label = (await settingsButton()).getAttribute("aria-label") ?? "";
  return label.split(", ").slice(1);
}

/** The same, at once, for use inside `waitFor`: nothing before the button is drawn. */
function named() {
  const button = screen.queryByRole("button", { name: /^Agent settings/ });
  return (button?.getAttribute("aria-label") ?? "").split(", ").slice(1);
}

/** The mode the settings button shows, by name. */
async function shownMode() {
  const label = (await settingsButton()).getAttribute("aria-label") ?? "";
  return label.split(", ").pop();
}

/** Wait for the settings button to show `name` as the mode. */
async function untilMode(name: string) {
  await waitFor(async () => expect(await shownMode()).toBe(name));
}

/** Choose a mode by name from the settings menu. */
async function pickMode(name: string) {
  const menu = await modeMenu();
  fireEvent.click(menu.getByRole("menuitemradio", { name }));
}

/** Choose `name` from the settings menu's `group` section. */
async function pick(group: string, name: string) {
  fireEvent.click(await settingsButton());
  const section = within(await screen.findByRole("group", { name: group }));
  await act(async () => {
    fireEvent.click(section.getByRole("menuitemradio", { name }));
  });
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

  it("sends on Enter to the tab's harness and clears the prompt", async () => {
    backend({ status: null, seq: 0, items: [] });
    render(<App />);
    await screen.findByText("No session");
    fireEvent.change(prompt(), { target: { value: "fix the test" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    // The host picks the harness: the live agent's, else the tab's choice.
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", { text: "fix the test" });
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
    await screen.findByText("No session");
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
          Promise.resolve({
            harnesses: [{ ...CLAUDE, hint: "signedOut" }],
            current: "claude",
            blocked: null,
          }),
      },
    );
    render(<App />);
    expect(await screen.findByText(strings.hint.signedOut(CLAUDE))).toBeTruthy();
  });

  it("words an error item's hint inside the error", async () => {
    backend({
      status: STATUS,
      seq: 2,
      items: [
        item("e1", { kind: "error", message: "boom", hint: "harnessMissing", harness: "claude" }),
      ],
    });
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
    expect(alert.textContent).toContain(strings.hint.harnessMissing(CLAUDE));
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
    await screen.findByText("No session");
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
        item("e2", { kind: "error", message: "overloaded", hint: null, harness: "claude" }),
      ],
    });
    render(<App />);
    await screen.findByText("fix the build");
    fireEvent.change(prompt(), { target: { value: "half typed" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", { text: "fix the build" });
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
    expect(document.querySelector(".at-empty")).toBeNull();
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
        item("e2", {
          kind: "error",
          message: "authentication required",
          hint: "signedOut",
          harness: "claude",
        }),
      ],
    });
    render(<App />);
    await screen.findByText("the one that failed");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", { text: "the one that failed" });
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
          item("e1", { kind: "error", message: "boom", hint: null, harness: "claude" }),
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
      name: "The mode and model appear once the session starts.",
    });
    expect(later.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true });
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/set-mode", expect.anything());
  });

  it("switches mode with Shift+Tab, showing the choice until the agent answers it", async () => {
    backend({ status: SETTINGS, seq: 1, items: [] });
    render(<App />);
    await untilMode("Manual");
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

  it("switches once for a held Shift+Tab, and keeps focus where it is", async () => {
    backend({ status: SETTINGS, seq: 1, items: [] });
    render(<App />);
    await untilMode("Manual");
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true });
    });
    let notPrevented = true;
    await act(async () => {
      for (let i = 0; i < 5; i++) {
        notPrevented &&= fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true, repeat: true });
      }
    });
    expect(notPrevented).toBe(false);
    const sent = bridge.invoke.mock.calls.filter(([m]) => m === "agent-tab/set-mode");
    expect(sent).toEqual([["agent-tab/set-mode", { modeId: "acceptEdits" }]]);
    expect(await shownMode()).toBe("Accept edits");
  });

  it.each([
    ["has no modes", { ...STATUS, modes: [] }],
    ["has only the mode it is in", { ...STATUS, modes: [choice("default", "Manual")] }],
    ["has ended", { ...SETTINGS, state: "stopped" as const }],
    ["failed", { ...SETTINGS, state: "failed" as const }],
  ])("leaves Shift+Tab to move focus when the session %s", async (_, status) => {
    backend({ status, seq: 1, items: [] });
    render(<App />);
    await screen.findByRole("textbox", { name: "Message the agent" });
    const notPrevented = fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true });
    expect(notPrevented).toBe(true);
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/set-mode", expect.anything());
  });

  it("keeps a choice shown when its status comes before the call's number", async () => {
    let number!: (answer: { ticket: number }) => void;
    backend(
      { status: SETTINGS, seq: 1, items: [] },
      { "agent-tab/set-mode": () => new Promise((resolve) => (number = resolve)) },
    );
    render(<App />);
    await act(async () => {
      await pickMode("Plan");
    });
    expect(await shownMode()).toBe("Plan");

    // The agent answered, settling elsewhere, before the call returned: the
    // choice is not taken back to the old mode, nor given the new one yet.
    emit({
      instanceId: "i",
      seq: 2,
      event: { type: "status", status: { ...SETTINGS, mode: "acceptEdits", answered: 1 } },
    });
    expect(await shownMode()).toBe("Plan");

    // Once the call is numbered, that status is the answer to it.
    await act(async () => number({ ticket: 1 }));
    expect(await shownMode()).toBe("Accept edits");
  });

  it("keeps the last choice shown when the calls return out of order", async () => {
    const numbers: ((answer: { ticket: number }) => void)[] = [];
    backend(
      { status: SETTINGS, seq: 1, items: [] },
      { "agent-tab/set-mode": () => new Promise((resolve) => numbers.push(resolve)) },
    );
    render(<App />);
    const status = (seq: number, mode: string, answered: number) =>
      emit({
        instanceId: "i",
        seq,
        event: { type: "status", status: { ...SETTINGS, mode, answered } },
      });
    await act(async () => {
      await pickMode("Accept edits");
    });
    await act(async () => {
      await pickMode("Plan");
    });

    // The second call returns first, then the first.
    await act(async () => numbers[1]({ ticket: 2 }));
    await act(async () => numbers[0]({ ticket: 1 }));
    expect(await shownMode()).toBe("Plan");

    // The first answer is not the last: the second choice stands.
    status(2, "acceptEdits", 1);
    expect(await shownMode()).toBe("Plan");

    // Both are answered, and the select follows the agent again.
    status(3, "default", 2);
    expect(await shownMode()).toBe("Manual");
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

    // A refusal that gives no reason does not end on a colon.
    status(4, {
      ...SETTINGS,
      answered: 2,
      settingTrouble: { kind: "refused", ticket: 2, message: "" },
    });
    await screen.findByText("The agent refused that change.");

    // Once the session ends there is nothing left to answer it.
    status(5, {
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
    expect(screen.queryByText("The mode and model appear once the session starts.")).toBeNull();
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
    await untilMode("auto");
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Tab", shiftKey: true });
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/set-mode", { modeId: "default" });
  });

  it("picks the model and effort from the agent's own lists", async () => {
    backend({ status: MODELS, seq: 1, items: [] });
    render(<App />);
    await waitFor(async () =>
      expect(await shown()).toEqual(["Claude", "Default (recommended)", "Default", "Manual"]),
    );
    fireEvent.click(await settingsButton());
    const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups.slice(-2), "the model is under its harness").toEqual(["Effort", "Mode"]);
    expect(groups, "fast mode is not drawn here").not.toContain("Fast mode");
    const status = (seq: number, status: SessionStatus) =>
      emit({ instanceId: "i", seq, event: { type: "status", status } });

    await act(async () => {
      const claude = within(screen.getByRole("group", { name: "Claude" }));
      fireEvent.click(claude.getByRole("menuitemradio", { name: "Opus" }));
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/set-config", {
      configId: "model",
      value: "opus",
    });
    expect(await shown()).toEqual(["Claude", "Opus", "Default", "Manual"]);

    // The answer lists the new model's own levels.
    const opus: SessionStatus = {
      ...MODELS,
      answered: 1,
      config: [
        { ...MODELS.config[0], value: "opus" },
        option("effort", "Effort", "thought_level", "default", [...LEVELS, ["xhigh", "Xhigh"]]),
      ],
    };
    status(2, opus);
    expect(await shown()).toEqual(["Claude", "Opus", "Default", "Manual"]);
    fireEvent.click(await settingsButton());
    const effort = within(screen.getByRole("group", { name: "Effort" }));
    const levels = effort.getAllByRole("menuitemradio").map((o) => o.textContent);
    expect(levels).toEqual(["Default", "Low", "High", "Xhigh"]);

    await act(async () => {
      fireEvent.click(effort.getByRole("menuitemradio", { name: "Xhigh" }));
    });
    expect(bridge.invoke).toHaveBeenLastCalledWith("agent-tab/set-config", {
      configId: "effort",
      value: "xhigh",
    });
    expect(await shown()).toEqual(["Claude", "Opus", "Xhigh", "Manual"]);

    // A model with no effort has no effort section.
    status(3, { ...MODELS, answered: 2, config: [{ ...MODELS.config[0], value: "haiku" }] });
    expect(await shown()).toEqual(["Claude", "Haiku", "Manual"]);
    fireEvent.click(await settingsButton());
    expect(screen.queryByRole("group", { name: "Effort" })).toBeNull();
  });

  it("holds each setting's choice until its own answer", async () => {
    backend({ status: MODELS, seq: 1, items: [] });
    render(<App />);
    await untilMode("Manual");
    const status = (seq: number, status: SessionStatus) =>
      emit({ instanceId: "i", seq, event: { type: "status", status } });
    await pick("Effort", "High");
    await pick("Claude", "Opus");
    expect(await shown()).toEqual(["Claude", "Opus", "High", "Manual"]);

    // The agent refuses the effort and has yet to answer the model.
    status(2, {
      ...MODELS,
      answered: 1,
      settingTrouble: { kind: "refused", ticket: 1, message: "not for this model" },
    });
    await screen.findByText("The agent refused that change: not for this model");
    expect(
      await shown(),
      "the refused effort is taken back, and the unanswered model still stands",
    ).toEqual(["Claude", "Opus", "Default", "Manual"]);

    status(3, { ...MODELS, answered: 2, config: [{ ...MODELS.config[0], value: "opus" }] });
    expect(await shown()).toEqual(["Claude", "Opus", "Manual"]);
  });

  it("takes back only the choice the host refused", async () => {
    backend(
      { status: MODELS, seq: 1, items: [] },
      {
        "agent-tab/set-config": () =>
          Promise.reject(
            new bridge.KaavaRpcError(-32010, "x", { code: "unknownOption", hint: null }),
          ),
      },
    );
    render(<App />);
    await untilMode("Manual");
    await pickMode("Plan");
    await pick("Effort", "High");
    await screen.findByRole("alert");
    expect(await shown(), "the mode change is still on its way").toEqual([
      "Claude",
      "Default (recommended)",
      "Default",
      "Plan",
    ]);
  });

  it("never names the harness Claude Code", async () => {
    backend({ status: STATUS, seq: 1, items: [] });
    render(<App />);
    expect((await screen.findAllByText("Claude")).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("Claude Code");
  });
});

describe("the harness", () => {
  const MODEL = {
    id: "model",
    name: "Model",
    description: null,
    category: "model",
    value: "opus",
    choices: [{ value: "opus", name: "Opus", description: null }],
  };

  it("names the running harness and its model on the settings button", async () => {
    backend({ status: { ...STATUS, config: [MODEL] }, seq: 1, items: [] });
    render(<App />);
    await waitFor(async () => expect(await shown()).toEqual(expect.arrayContaining(["Opus"])));
    expect(await shown()).toContain("Claude");
  });

  it("drops an ended session's model, which the next prompt does not run", async () => {
    backend({ status: { ...STATUS, state: "stopped", config: [MODEL] }, seq: 1, items: [] });
    render(<App />);
    await waitFor(async () => expect(await shown()).toContain("Claude"));
    expect(await shown()).not.toContain("Opus");
  });

  it("has no header bar to name it in: the pane's tab and this button do", async () => {
    backend({ status: { ...STATUS, config: [MODEL] }, seq: 1, items: [] });
    const { container } = render(<App />);
    await waitFor(async () => expect(await shown()).toContain("Opus"));
    expect(container.querySelector(".at-header")?.textContent).not.toContain("Opus");
    expect(screen.getByRole("button", { name: "New session" })).toBeTruthy();
  });

  /** A second harness, fictional: the registry lists only Claude so far. */
  const PI = { ...CLAUDE, harness: "pi", name: "Pi" } as unknown as HarnessInfo;
  const both = () => Promise.resolve({ harnesses: [CLAUDE, PI], current: "claude", blocked: null });

  /** The one item under harness `name` in the settings menu: its default model. */
  async function harnessItem(name: string) {
    fireEvent.click(await settingsButton());
    const group = await screen.findByRole("group", { name });
    return within(group).getByRole("menuitemradio");
  }

  it("is chosen in the settings menu, and the host is told", async () => {
    backend({ status: null, seq: 0, items: [] }, { "agent-tab/harnesses": both });
    render(<App />);
    const pi = await harnessItem("Pi");
    expect(pi.getAttribute("aria-disabled")).toBe("false");
    await act(async () => {
      fireEvent.click(pi);
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/choose", { harness: "pi", model: null });
  });

  it("sends the model picked under a harness, and lists the harnesses again", async () => {
    const offered = [
      { value: "default", name: "Default", description: null },
      { value: "opus", name: "Opus", description: null },
    ];
    const claude = { ...CLAUDE, models: offered, model: "default" };
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/harnesses": () =>
          Promise.resolve({ harnesses: [claude], current: "claude", blocked: null }),
      },
    );
    const asked = () =>
      bridge.invoke.mock.calls.filter(([method]) => method === "agent-tab/harnesses").length;
    render(<App />);
    await waitFor(() => expect(asked()).toBe(1));
    fireEvent.click(await settingsButton());
    const group = await screen.findByRole("group", { name: "Claude" });
    await act(async () => {
      fireEvent.click(within(group).getByRole("menuitemradio", { name: /Opus/ }));
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/choose", {
      harness: "claude",
      model: "opus",
    });
    await waitFor(() => expect(asked()).toBe(2));
  });

  it("cannot be switched while its agent runs", async () => {
    backend({ status: STATUS, seq: 1, items: [] }, { "agent-tab/harnesses": both });
    render(<App />);
    expect((await harnessItem("Pi")).getAttribute("aria-disabled")).toBe("true");
  });

  it("shows a choice the host refused", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/harnesses": both,
        "agent-tab/choose": () =>
          Promise.reject(new bridge.KaavaRpcError(-32010, "x", { code: "running", hint: null })),
      },
    );
    render(<App />);
    const pi = await harnessItem("Pi");
    await act(async () => {
      fireEvent.click(pi);
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Start a new session to switch.");
  });

  it("follows a choice made in the agent bar", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/harnesses": () =>
          Promise.resolve({ harnesses: [CLAUDE, CODEX], current: "codex", blocked: null }),
      },
    );
    render(<App />);
    await waitFor(() => expect(named()).toContain("Codex"));
    act(() => bridge.listeners.get("agent-tab:chosen")?.({ instanceId: "i", harness: "claude" }));
    expect(named()).toContain("Claude");
    expect(named()).not.toContain("Codex");
  });

  it("says a switch failed, not a send, when choosing fails", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/harnesses": both,
        "agent-tab/choose": () => Promise.reject(new Error("gone")),
      },
    );
    render(<App />);
    const pi = await harnessItem("Pi");
    await act(async () => {
      fireEvent.click(pi);
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not switch the harness.");
    expect(alert.textContent).not.toContain("Could not send that.");
  });

  it("keeps a choice it heard of while its list of harnesses was on the way", async () => {
    let reply: ((answer: unknown) => void) | undefined;
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/harnesses": () =>
          new Promise((resolve) => {
            reply = resolve;
          }),
      },
    );
    render(<App />);
    await waitFor(() => expect(reply).toBeDefined());
    act(() => bridge.listeners.get("agent-tab:chosen")?.({ instanceId: "i", harness: "pi" }));
    // Asked before the choice, so its `current` is older than it.
    await act(async () => reply?.({ harnesses: [CLAUDE, PI], current: "claude", blocked: null }));
    expect(named()).toContain("Pi");
    expect(named()).not.toContain("Claude");
  });

  it("offers to list the harnesses again when the list fails", async () => {
    let attempts = 0;
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/harnesses": () =>
          ++attempts === 1
            ? Promise.reject(new Error("not yet"))
            : Promise.resolve({ harnesses: [CLAUDE], current: "claude", blocked: null }),
      },
    );
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not list the harnesses.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => expect(named()).toContain("Claude"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("words an ended session's hint for its own harness, not the one chosen next", async () => {
    const pi = { ...PI, setup: { ...CLAUDE.setup, cli: "pi", signIn: "pi login" } };
    backend(
      { status: { ...STATUS, state: "stopped", hint: "signedOut" }, seq: 1, items: [] },
      {
        "agent-tab/harnesses": () =>
          Promise.resolve({ harnesses: [CLAUDE, pi], current: "pi", blocked: null }),
      },
    );
    render(<App />);
    await waitFor(() => expect(named()).toContain("Pi"));
    await screen.findByText(/Claude is not signed in\. Run `claude` once/);
    expect(document.body.textContent).not.toContain("pi login");
  });

  it("says what the chosen harness still needs, in its own commands", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      {
        "agent-tab/harnesses": () =>
          Promise.resolve({
            harnesses: [{ ...CLAUDE, hint: "signedOut" }],
            current: "claude",
            blocked: null,
          }),
      },
    );
    render(<App />);
    await screen.findByText(/Claude is not signed in\. Run `claude` once/);
  });

  it("words an earlier session's error for the harness that raised it", async () => {
    const signedOut = item("e1", {
      kind: "error",
      message: "auth required",
      hint: "signedOut",
      harness: "claude",
    });
    backend(
      { status: { ...STATUS, harness: "codex" }, seq: 3, items: [signedOut] },
      {
        "agent-tab/harnesses": () =>
          Promise.resolve({ harnesses: [CLAUDE, CODEX], current: "codex", blocked: null }),
      },
    );
    render(<App />);
    await screen.findByText(/Claude is not signed in\. Run `claude` once/);
    expect(screen.queryByText(/codex login/)).toBeNull();
  });

  it("asks for the harnesses again once an agent's models are in", async () => {
    backend({ status: null, seq: 0, items: [] });
    const asked = () =>
      bridge.invoke.mock.calls.filter(([method]) => method === "agent-tab/harnesses").length;
    render(<App />);
    await waitFor(() => expect(asked()).toBe(1));
    act(() => bridge.listeners.get("agent-tab:models")?.({ instanceId: "i", harness: "claude" }));
    await waitFor(() => expect(asked()).toBe(2));
  });
});

describe("slash commands", () => {
  const WITH_COMMANDS: SessionStatus = {
    ...STATUS,
    commands: [
      { name: "compact", description: "Clear history", hint: "instructions" },
      { name: "init", description: "Set up CLAUDE.md", hint: null },
    ],
  };

  async function ready(status: SessionStatus | null) {
    backend({ status, seq: 1, items: [] });
    render(<App />);
    await screen.findByRole("status");
  }

  const names = () => screen.queryAllByRole("option").map((o) => o.textContent);

  it("lists the agent's commands, and login, for a bare slash", async () => {
    await ready(WITH_COMMANDS);
    fireEvent.change(prompt(), { target: { value: "/" } });
    expect(names()).toEqual([
      "compactClear history",
      "initSet up CLAUDE.md",
      "loginSign in to your account",
    ]);
  });

  it("filters as the name is typed, and offers nothing once an argument starts", async () => {
    await ready(WITH_COMMANDS);
    fireEvent.change(prompt(), { target: { value: "/co" } });
    expect(names()).toEqual(["compactClear history"]);
    fireEvent.change(prompt(), { target: { value: "/compact now" } });
    expect(names()).toEqual([]);
  });

  it("offers login before any session has listed commands", async () => {
    await ready(null);
    fireEvent.change(prompt(), { target: { value: "/" } });
    expect(names()).toEqual(["loginSign in to your account"]);
  });

  it("moves with the arrows, and Enter fills the name instead of sending it", async () => {
    await ready(WITH_COMMANDS);
    fireEvent.change(prompt(), { target: { value: "/" } });
    fireEvent.keyDown(prompt(), { key: "ArrowDown" });
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("init");
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(prompt()).toHaveProperty("value", "/init ");
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/send", expect.anything());
  });

  it("fills on Tab or a click, and closes on Escape until the draft changes", async () => {
    await ready(WITH_COMMANDS);
    fireEvent.change(prompt(), { target: { value: "/co" } });
    fireEvent.keyDown(prompt(), { key: "Tab" });
    expect(prompt()).toHaveProperty("value", "/compact ");
    fireEvent.change(prompt(), { target: { value: "/i" } });
    fireEvent.click(screen.getByRole("option", { name: /init/ }));
    expect(prompt()).toHaveProperty("value", "/init ");
    fireEvent.change(prompt(), { target: { value: "/c" } });
    fireEvent.keyDown(prompt(), { key: "Escape" });
    expect(names()).toEqual([]);
    fireEvent.change(prompt(), { target: { value: "/co" } });
    expect(names()).toEqual(["compactClear history"]);
  });

  it("sends a command typed out in full that takes no argument", async () => {
    await ready(WITH_COMMANDS);
    fireEvent.change(prompt(), { target: { value: "/init" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/send", { text: "/init" });
  });

  it("signs in on /login without sending it to the agent, and says how it ended", async () => {
    await ready(null);
    fireEvent.change(prompt(), { target: { value: "/login" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(bridge.invoke).toHaveBeenCalledWith("agent-tab/login");
    expect(bridge.invoke).not.toHaveBeenCalledWith("agent-tab/send", expect.anything());
    expect(prompt()).toHaveProperty("value", "");
    expect(await screen.findByText("Finish signing in to Claude in your browser.")).toBeTruthy();

    act(() => bridge.listeners.get("agent-tab:login")?.({ harness: "claude", ok: true }));
    expect(
      await screen.findByText("Signed in to Claude. Send a prompt to start a session."),
    ).toBeTruthy();
    act(() => bridge.listeners.get("agent-tab:login")?.({ harness: "claude", ok: false }));
    expect(await screen.findByText("Could not sign in to Claude. Try /login again.")).toBeTruthy();
  });

  it("names a sign-in that could not start", async () => {
    backend(
      { status: null, seq: 0, items: [] },
      { "agent-tab/login": () => Promise.reject(new Error("no")) },
    );
    render(<App />);
    await screen.findByText("No session");
    fireEvent.change(prompt(), { target: { value: "/login" } });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: "Enter" });
    });
    expect(await screen.findByText("Could not start the sign-in.")).toBeTruthy();
  });
});
