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
import type { Attachment, Envelope, Event, Item, SessionStatus } from "./protocol.generated";

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

/** Whether a turn is open: the prompt box sends nothing until it closes. */
export function busy(status: SessionStatus | null): boolean {
  return status?.state === "working" || status?.state === "needsInput";
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
