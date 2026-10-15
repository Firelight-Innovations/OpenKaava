/**
 * The tab's transcript: what `agent-tab/attach` answered, plus every live
 * envelope after it.
 *
 * The same rules as `crates/kaava-agent-host/src/transcript.rs`, so the tab
 * and the host cannot disagree: an item event replaces the item with that id
 * (or appends it), a delta appends text, and a reset clears everything.
 *
 * Ordering: the tab subscribes first and attaches second. Envelopes that
 * arrive before the attach answers are held, then applied if their `seq` is
 * past the one the attach reported. After that, an envelope applies only if its
 * `seq` is greater than the last one applied, so a duplicate or a stale
 * envelope changes nothing.
 */
import type {
  Attachment,
  ConfigChoice,
  ConfigOption,
  Envelope,
  Event,
  Item,
  SessionStatus,
} from "./protocol.generated";

/** Mirrors `transcript::MAX_ITEMS`. */
export const MAX_ITEMS = 2000;

export interface TabState {
  attached: boolean;
  lastSeq: number;
  status: SessionStatus | null;
  items: Item[];
  /** Envelopes that arrived before the attach answered. */
  held: Envelope[];
}

export const initialState: TabState = {
  attached: false,
  lastSeq: 0,
  status: null,
  items: [],
  held: [],
};

export function attached(state: TabState, attachment: Attachment): TabState {
  let next: TabState = {
    attached: true,
    lastSeq: attachment.seq,
    status: attachment.status,
    items: attachment.items,
    held: [],
  };
  for (const envelope of state.held) next = received(next, envelope);
  return next;
}

export function received(state: TabState, envelope: Envelope): TabState {
  if (!state.attached) return { ...state, held: [...state.held, envelope] };
  if (envelope.seq <= state.lastSeq) return state;
  return { ...apply(state, envelope.event), lastSeq: envelope.seq };
}

function apply(state: TabState, event: Event): TabState {
  switch (event.type) {
    case "status":
      return { ...state, status: event.status };
    case "itemStarted":
    case "itemUpdated":
    case "itemCompleted":
      return { ...state, items: upsert(state.items, event.item) };
    case "itemDelta":
      return { ...state, items: appendText(state.items, event.itemId, event.text) };
    case "reset":
      return { ...state, status: null, items: [] };
    case "turnStarted":
    case "turnCompleted":
      return state;
  }
}

function indexOf(items: Item[], id: string): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].id === id) return i;
  return -1;
}

function upsert(items: Item[], item: Item): Item[] {
  const at = indexOf(items, item.id);
  if (at >= 0) return items.map((have, i) => (i === at ? item : have));
  const next = [...items, item];
  return next.length > MAX_ITEMS ? next.slice(next.length - MAX_ITEMS) : next;
}

function appendText(items: Item[], id: string, text: string): Item[] {
  const at = indexOf(items, id);
  if (at < 0) return items;
  const kind = items[at].kind;
  if (kind.kind !== "assistantText" && kind.kind !== "reasoning") return items;
  const grown: Item = { ...items[at], kind: { ...kind, text: kind.text + text } };
  return items.map((have, i) => (i === at ? grown : have));
}

/**
 * Whether a turn is open or about to be: the prompt box sends nothing until it
 * closes. `starting` counts, because the host holds the first prompt through
 * the handshake (up to a minute) and Stop is what withdraws it.
 */
export function busy(status: SessionStatus | null): boolean {
  return (
    status?.state === "starting" || status?.state === "working" || status?.state === "needsInput"
  );
}

/**
 * Whether a mode or setting can change now: past the handshake and still
 * running. A turn in progress does not block it, as in Claude's own terminal.
 * A plain boolean, not a type guard: a stopped session is a status too, and
 * narrowing it away as `null` would mislead whatever reads it next.
 */
export function settable(status: SessionStatus | null): boolean {
  const state = status?.state;
  return state !== undefined && state !== "starting" && state !== "stopped" && state !== "failed";
}

/**
 * Setting choices the agent has not answered yet, shown in place of what the
 * status says. Each change the host queues comes back with a number, and the
 * choices stand until a status's `answered` reaches the last of them, so a
 * status sent for anything else (a turn starting or ending) does not undo
 * them.
 */
export interface Pending {
  mode?: string;
  /** Values chosen for the agent's other options, by option id. */
  config?: Record<string, string>;
  /** The highest number the host has given these changes so far. */
  ticket: number;
  /** Changes sent whose number has not come back yet. */
  unnumbered: number;
}

/** `pending` while the agent has yet to answer it, otherwise `null`. */
export function unanswered(pending: Pending | null, status: SessionStatus | null): Pending | null {
  if (!pending || status === null || !settable(status)) return null;
  return pending.unnumbered > 0 || status.answered < pending.ticket ? pending : null;
}

/**
 * The categories drawn as a select beside the mode: the model, and the
 * effort, which ACP calls a thought level. Fast mode (`model_config`) is not
 * drawn here; PR 4 gives it a switch of its own.
 */
const PICKED: readonly string[] = ["model", "thought_level"];

/** The options drawn beside the mode, in the agent's order, as it lists them. */
export function pickers(status: SessionStatus): ConfigOption[] {
  return status.config.filter((o) => o.category !== null && PICKED.includes(o.category));
}

/**
 * The mode after `current` in the agent's own order, wrapping round, for
 * Shift+Tab. `null` when there is nothing else to switch to.
 */
export function nextMode(modes: ConfigChoice[], current: string | null): string | null {
  if (modes.length === 0) return null;
  const next = modes[(modes.findIndex((m) => m.value === current) + 1) % modes.length];
  return next.value === current ? null : next.value;
}

/**
 * What the user asked before the item `itemId`, for that item's Retry: the
 * prompt the error answered, not whatever was asked since. `null` if the item
 * is gone or nothing was asked before it.
 */
export function promptBefore(items: Item[], itemId: string): string | null {
  for (let i = indexOf(items, itemId) - 1; i >= 0; i--) {
    const kind = items[i].kind;
    if (kind.kind === "userMessage") return kind.text;
  }
  return null;
}
