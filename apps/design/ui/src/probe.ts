/**
 * The conversation between this app and the probe inside the page it is showing.
 *
 * The probe is `src-tauri/src/apps/design_probe.js`, compiled into the binary;
 * this is TypeScript in the shell's own build. Nothing links them but
 * `window.postMessage`, so the shapes are restated here — the same arrangement
 * `apps/files/ui/src/rpc.ts` has with its backend.
 *
 * Everything arriving is **untrusted**, so this module's real job is not
 * decoding but refusing: {@link readProbeMessage} returns `null` for anything
 * it cannot fully account for, and the app treats `null` as silence. Deciding
 * whether the *sender* may be heard is not done here; that is
 * `event.source === iframe.contentWindow`, at the listener.
 *
 * `docs/design-notes/design-mode.md` has the long form.
 */

/** Present on every message in both directions, so a page's own chatter and
 *  the bridge's transport-B traffic are told apart in one comparison. */
export const CHANNEL = "veistraDesign";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the page was, when the element was picked. */
export interface PickedPage {
  /** Query and fragment already stripped by the probe. */
  url: string;
  title: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
}

/** The element itself. Every string is already budgeted by the probe; the caps
 *  are documented there rather than restated here, because a second copy of a
 *  number is a second thing to keep in step. */
export interface PickedTarget {
  tagName: string;
  selector: string;
  ancestors: string;
  text: string;
  html: string;
  attributes: Record<string, string>;
  styles: Record<string, string>;
  /** In the *page's* viewport, not this window's. {@link absoluteRect} is what
   *  turns it into somewhere a screenshot can be cut from. */
  rect: Rect;
}

export interface PickedElement {
  page: PickedPage;
  target: PickedTarget;
}

export type ProbeMessage =
  | { kind: "armed" }
  | { kind: "disarmed" }
  | { kind: "veiled"; id: string }
  | { kind: "picked"; element: PickedElement }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** A string map, keeping only the entries that are actually strings. A page
 *  that put a function or a nested object in one is a page whose payload is
 *  wrong, not one worth failing the whole pick over. */
function strings(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function readRect(value: unknown): Rect {
  const raw = isObject(value) ? value : {};
  return {
    x: num(raw.x),
    y: num(raw.y),
    width: num(raw.width),
    height: num(raw.height),
  };
}

function readElement(value: unknown): PickedElement | null {
  if (!isObject(value)) return null;
  const page = isObject(value.page) ? value.page : null;
  const target = isObject(value.target) ? value.target : null;
  // The two halves are required rather than defaulted. An empty payload that
  // renders as an element with no tag and no markup is worse than nothing: it
  // looks like a capture that worked.
  if (!page || !target || typeof target.tagName !== "string") return null;

  return {
    page: {
      url: str(page.url),
      title: str(page.title),
      viewportWidth: num(page.viewportWidth),
      viewportHeight: num(page.viewportHeight),
      devicePixelRatio: num(page.devicePixelRatio) || 1,
    },
    target: {
      tagName: target.tagName,
      selector: str(target.selector),
      ancestors: str(target.ancestors),
      text: str(target.text),
      html: str(target.html),
      attributes: strings(target.attributes),
      styles: strings(target.styles),
      rect: readRect(target.rect),
    },
  };
}

/**
 * Read one `message` event's data, or refuse it.
 *
 * Refusing means `null`, and the caller must do nothing at all with a `null` —
 * not log it, not surface it. An app frame receives messages from things that
 * have nothing to do with it, and a page under inspection is at liberty to post
 * junk on purpose.
 */
export function readProbeMessage(data: unknown): ProbeMessage | null {
  if (!isObject(data) || data[CHANNEL] !== 1) return null;

  switch (data.kind) {
    case "armed":
      return { kind: "armed" };
    case "disarmed":
      return { kind: "disarmed" };
    case "cancelled":
      return { kind: "cancelled" };
    case "veiled":
      return typeof data.id === "string" ? { kind: "veiled", id: data.id } : null;
    case "failed":
      return { kind: "failed", reason: str(data.reason) || "the page would not describe that" };
    case "picked": {
      const element = readElement(data.element);
      return element ? { kind: "picked", element } : null;
    }
    default:
      return null;
  }
}

/** What this app sends the other way. Mirrors `onMessage` in the probe. */
export type ProbeCommand =
  { kind: "arm" } | { kind: "disarm" } | { kind: "veil"; on: boolean; id: string };

/** Wrap a command in the channel marker. Separate from sending it so the shape
 *  can be asserted without a `window`. */
export function envelope(command: ProbeCommand): Record<string, unknown> {
  return { [CHANNEL]: 1, ...command };
}

/**
 * Where an element sits in the top-level window, given where every frame
 * between it and that window sits in its own parent.
 *
 * The reason this is arithmetic in a testable function rather than a line
 * inside a click handler: it is the one part of the screenshot path that is
 * silently wrong rather than loudly broken when it is wrong. A missed frame
 * offset produces a real photograph of the wrong thing, and no error anywhere.
 *
 * `frames` runs inner to outer — the rect of the iframe holding the page, then
 * the rect of the iframe holding *that*, and so on up. An empty list means the
 * element is already in the top-level document's coordinates.
 */
export function absoluteRect(element: Rect, frames: readonly Rect[]): Rect {
  let { x, y } = element;
  for (const frame of frames) {
    x += frame.x;
    y += frame.y;
  }
  return { x, y, width: element.width, height: element.height };
}
