/**
 * Pins: a numbered marker that also records what it was placed on.
 *
 * A pin is two Excalidraw elements, an ellipse and the text bound inside it,
 * sharing a group id. The ellipse carries `customData.kaava = { kind: "pin", n,
 * note, nodePath?, worldPoint? }`; the label carries `{ kind: "pin-label", n }`
 * so that a reader listing pins never counts it twice.
 */
import { kaavaData, live, touch, withKaava } from "./elements";
import type { MarkupElement, PinData, Vec3 } from "./types";

/** Diameter of the marker, in host pixels. */
export const PIN_SIZE = 32;

export interface PinColors {
  fill: string;
  stroke: string;
  text: string;
}

export interface PinInput {
  n: number;
  /** The centre of the marker: where the pin was placed. */
  x: number;
  y: number;
  note?: string;
  nodePath?: string;
  worldPoint?: Vec3;
  colors: PinColors;
}

/**
 * The next pin number. Numbers are never reused, so a deleted pin's number
 * stays retired: the maximum is taken over deleted elements too, and `floor`
 * carries the high-water mark for callers that have already dropped them.
 */
export function nextPinNumber(elements: readonly MarkupElement[], floor = 0): number {
  let max = floor;
  for (const el of elements) {
    const data = kaavaData(el);
    if (data && (data.kind === "pin" || data.kind === "pin-label") && typeof data.n === "number") {
      if (data.n > max) max = data.n;
    }
  }
  return max + 1;
}

export function pinGroupId(n: number): string {
  return `kaava-pin-${n}`;
}

export interface PinSkeleton {
  id: string;
  type: "ellipse";
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: "solid";
  strokeWidth: number;
  roughness: number;
  groupIds: string[];
  customData: { kaava: PinData };
  label: {
    text: string;
    fontSize: number;
    strokeColor: string;
    groupIds: string[];
    customData: { kaava: { kind: "pin-label"; n: number } };
  };
}

/**
 * The skeleton Excalidraw's `convertToExcalidrawElements` turns into a pin: an
 * ellipse with its number as bound text. Plain data, so it can be tested and
 * carries no Excalidraw import.
 */
export function pinSkeleton(input: PinInput): PinSkeleton {
  const { n, x, y, colors } = input;
  const data: PinData = { kind: "pin", n, note: input.note ?? "" };
  if (input.nodePath !== undefined) data.nodePath = input.nodePath;
  if (input.worldPoint !== undefined) data.worldPoint = input.worldPoint;
  const group = pinGroupId(n);
  return {
    id: `${group}-marker`,
    type: "ellipse",
    x: x - PIN_SIZE / 2,
    y: y - PIN_SIZE / 2,
    width: PIN_SIZE,
    height: PIN_SIZE,
    strokeColor: colors.stroke,
    backgroundColor: colors.fill,
    fillStyle: "solid",
    strokeWidth: 2,
    roughness: 0,
    groupIds: [group],
    customData: { kaava: data },
    label: {
      text: String(n),
      fontSize: 16,
      strokeColor: colors.text,
      groupIds: [group],
      customData: { kaava: { kind: "pin-label", n } },
    },
  };
}

export interface PinRecord extends PinData {
  /** Centre of the marker in host pixels. */
  x: number;
  y: number;
}

/** Every live pin, in number order. */
export function listPins(elements: readonly MarkupElement[]): PinRecord[] {
  const pins: PinRecord[] = [];
  for (const el of live(elements)) {
    const data = kaavaData(el);
    if (!data || data.kind !== "pin" || typeof data.n !== "number") continue;
    const pin: PinRecord = {
      kind: "pin",
      n: data.n,
      note: typeof data.note === "string" ? data.note : "",
      x: el.x + el.width / 2,
      y: el.y + el.height / 2,
    };
    if (typeof data.nodePath === "string") pin.nodePath = data.nodePath;
    if (Array.isArray(data.worldPoint)) pin.worldPoint = data.worldPoint as Vec3;
    pins.push(pin);
  }
  return pins.sort((a, b) => a.n - b.n);
}

export function isPinPart(el: MarkupElement): boolean {
  const kind = kaavaData(el)?.kind;
  return kind === "pin" || kind === "pin-label";
}

function pinNumberOf(el: MarkupElement): number | null {
  const data = kaavaData(el);
  if (!data || (data.kind !== "pin" && data.kind !== "pin-label")) return null;
  return typeof data.n === "number" ? data.n : null;
}

/** Sets the note of pin `n`. Elements that are not that pin are returned as they were. */
export function setPinNote(
  elements: readonly MarkupElement[],
  n: number,
  note: string,
): MarkupElement[] {
  return elements.map((el) => {
    const data = kaavaData(el);
    return data && data.kind === "pin" && data.n === n ? withKaava(el, { note }) : el;
  });
}

/** Moves pin `n` so that its marker is centred on (x, y); its label follows. */
export function movePinTo(
  elements: readonly MarkupElement[],
  n: number,
  x: number,
  y: number,
): MarkupElement[] {
  const marker = elements.find(
    (el) => !el.isDeleted && kaavaData(el)?.kind === "pin" && pinNumberOf(el) === n,
  );
  if (!marker) return elements.slice();
  const dx = x - (marker.x + marker.width / 2);
  const dy = y - (marker.y + marker.height / 2);
  if (dx === 0 && dy === 0) return elements.slice();
  return elements.map((el) =>
    pinNumberOf(el) === n ? touch(el, { x: el.x + dx, y: el.y + dy }) : el,
  );
}
