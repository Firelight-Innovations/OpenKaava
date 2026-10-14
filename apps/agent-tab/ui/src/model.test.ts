import { describe, expect, it } from "vitest";
import {
  attached,
  busy,
  initialState,
  nextMode,
  promptBefore,
  received,
  settable,
  unanswered,
  MAX_ITEMS,
} from "./model";
import type { Envelope, Event, Item, SessionStatus } from "./protocol.generated";

const text = (id: string, body: string): Item => ({
  id,
  turnId: "t1",
  kind: { kind: "assistantText", text: body },
});

const envelope = (seq: number, event: Event): Envelope => ({ instanceId: "a-1", seq, event });

const status = (state: SessionStatus["state"]): SessionStatus => ({
  state,
  harness: "claude",
  cwd: "C:/wt/x",
  mode: "default",
  modes: [],
  config: [],
  answered: 0,
  adapterVersion: "0.90.0",
  exitCode: null,
  hint: null,
  pendingPrompt: null,
});

const texts = (items: Item[]) =>
  items.map((i) => (i.kind.kind === "assistantText" ? i.kind.text : i.kind.kind));

describe("the transcript", () => {
  it("holds envelopes until the attach answers, then applies only newer ones", () => {
    let state = received(initialState, envelope(4, { type: "itemStarted", item: text("i1", "") }));
    state = received(state, envelope(6, { type: "itemDelta", itemId: "i1", text: "late" }));
    expect(state.items).toEqual([]);

    // The attach already includes seq 4 and below.
    state = attached(state, { status: status("working"), items: [text("i1", "Hi ")], seq: 5 });
    expect(texts(state.items)).toEqual(["Hi late"]);
    expect(state.lastSeq).toBe(6);
  });

  it("ignores a duplicate or stale envelope", () => {
    let state = attached(initialState, { status: null, items: [], seq: 0 });
    const start = envelope(1, { type: "itemStarted", item: text("i1", "") });
    const delta = envelope(2, { type: "itemDelta", itemId: "i1", text: "once" });
    for (const e of [start, delta, delta, start]) state = received(state, e);
    expect(texts(state.items)).toEqual(["once"]);
  });

  it("replaces an item in place and appends a new one", () => {
    let state = attached(initialState, { status: null, items: [text("i1", "a")], seq: 0 });
    state = received(state, envelope(1, { type: "itemStarted", item: text("i2", "b") }));
    state = received(state, envelope(2, { type: "itemCompleted", item: text("i1", "A") }));
    expect(texts(state.items)).toEqual(["A", "b"]);
  });

  it("clears on reset, status included", () => {
    let state = attached(initialState, {
      status: status("ready"),
      items: [text("i1", "a")],
      seq: 3,
    });
    state = received(state, envelope(4, { type: "reset" }));
    expect(state.items).toEqual([]);
    expect(state.status).toBeNull();
  });

  it("keeps at most MAX_ITEMS, dropping the oldest", () => {
    const many = Array.from({ length: MAX_ITEMS }, (_, i) => text(`i${i}`, String(i)));
    let state = attached(initialState, { status: null, items: many, seq: 0 });
    state = received(state, envelope(1, { type: "itemStarted", item: text("new", "new") }));
    expect(state.items).toHaveLength(MAX_ITEMS);
    expect(state.items[0].id).toBe("i1");
  });

  it("knows when a turn is open and what was last asked", () => {
    expect(busy(status("working"))).toBe(true);
    expect(busy(status("needsInput"))).toBe(true);
    expect(busy(status("starting"))).toBe(true);
    expect(busy(status("failed"))).toBe(false);
    expect(busy(status("stopped"))).toBe(false);
    expect(busy(status("ready"))).toBe(false);
    expect(busy(null)).toBe(false);
    const items: Item[] = [
      { id: "u1", turnId: "t1", kind: { kind: "userMessage", text: "first" } },
      text("i2", "failed"),
      { id: "u3", turnId: "t2", kind: { kind: "userMessage", text: "second" } },
      text("i4", "answer"),
    ];
    expect(promptBefore(items, "i2")).toBe("first");
    expect(promptBefore(items, "i4")).toBe("second");
    expect(promptBefore(items, "u1")).toBeNull();
    expect(promptBefore(items, "gone")).toBeNull();
  });

  it("finds the prompt of a handshake that failed, which the host draws ahead of the error", () => {
    const failed: Item[] = [
      { id: "u1", turnId: "t1", kind: { kind: "userMessage", text: "older" } },
      text("a1", "done"),
      { id: "u2", turnId: "t2", kind: { kind: "userMessage", text: "the one that failed" } },
      { id: "e2", turnId: "t2", kind: { kind: "error", message: "no sign-in", hint: "signedOut" } },
    ];
    expect(promptBefore(failed, "e2")).toBe("the one that failed");
  });
});

describe("the settings", () => {
  it("change only between the handshake and the exit", () => {
    expect(settable(status("ready"))).toBe(true);
    expect(settable(status("working"))).toBe(true);
    expect(settable(status("needsInput"))).toBe(true);
    expect(settable(status("starting"))).toBe(false);
    expect(settable(status("stopped"))).toBe(false);
    expect(settable(status("failed"))).toBe(false);
    expect(settable(null)).toBe(false);
  });

  it("cycle through the modes in the agent's order", () => {
    const modes = ["default", "acceptEdits", "plan"].map((value) => ({
      value,
      name: value,
      description: null,
    }));
    expect(nextMode(modes, "default")).toBe("acceptEdits");
    expect(nextMode(modes, "plan")).toBe("default");
    expect(nextMode(modes, "bypassPermissions")).toBe("default");
    expect(nextMode(modes, null)).toBe("default");
    expect(nextMode(modes.slice(0, 1), "default")).toBeNull();
    expect(nextMode([], "default")).toBeNull();
  });

  it("stand until the status that answers the last of them", () => {
    const pending = { mode: "plan", ticket: 3, unnumbered: 0 };
    const at = (answered: number) => ({ ...status("ready"), answered });
    expect(unanswered(pending, at(2))).toBe(pending);
    expect(unanswered(pending, at(3))).toBeNull();
    expect(unanswered({ ...pending, unnumbered: 1 }, at(3))).not.toBeNull();
    expect(unanswered(pending, { ...at(0), state: "stopped" })).toBeNull();
    expect(unanswered(null, at(0))).toBeNull();
  });
});
