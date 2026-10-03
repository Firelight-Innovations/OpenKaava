/**
 * Frames as labelled objects, the unit of detail on a canvas.
 *
 * A frame carries `customData.kaava.object = { type, props }`: the id of an
 * object type and the values of that type's fields. The frame's own element id
 * is its id and Excalidraw's `name` is its name. The Rust side
 * (`src-tauri/src/apps/canvas/frames.rs`) reads the same shape for the agent,
 * so this file and that one must agree.
 *
 * The type definitions come from `canvas/types`: the built-ins are code on the
 * Rust side and the project's own are in `.kaava/canvas/types.json`. Nothing
 * here knows what a "model" is except the export to the old spec-card JSON.
 *
 * Everything is pure, so the inspector's logic is tested without Excalidraw.
 */
import { isFrame } from "./nesting";
import type { SceneElement } from "./scene";
import { EMPTY_DRAFT, STATUSES, type SpecDraft, type SpecStatus } from "./spec";

export type FieldKind = "text" | "multiline" | "number" | "enum" | "path-list" | "bool";

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  default?: unknown;
  options?: string[];
  help?: string;
}

export interface TypeDef {
  id: string;
  name: string;
  color: string;
  icon: string;
  description?: string;
  fields: FieldDef[];
  builtin: boolean;
}

export interface FrameObject {
  type: string;
  props: Record<string, unknown>;
}

export const FIELD_KINDS: readonly FieldKind[] = [
  "text",
  "multiline",
  "number",
  "enum",
  "path-list",
  "bool",
];

export const ICON_NAMES = [
  "shapes",
  "box",
  "layers",
  "gamepad",
  "cog",
  "note",
  "star",
  "user",
  "map",
  "image",
  "music",
  "monitor",
] as const;

interface Kaava {
  object?: unknown;
}

function kaavaOf(el: SceneElement): Kaava | undefined {
  return (el.customData as { kaava?: Kaava } | undefined)?.kaava;
}

/** The object a frame carries, or `null` for a frame nobody has typed. */
export function objectOf(el: SceneElement): FrameObject | null {
  if (!isFrame(el) || el.isDeleted) return null;
  const raw = kaavaOf(el)?.object as { type?: unknown; props?: unknown } | undefined;
  if (!raw || typeof raw.type !== "string" || raw.type === "") return null;
  const props =
    raw.props && typeof raw.props === "object" && !Array.isArray(raw.props)
      ? (raw.props as Record<string, unknown>)
      : {};
  return { type: raw.type, props };
}

function touched(el: SceneElement, patch: Partial<SceneElement>): SceneElement {
  return {
    ...el,
    ...patch,
    version: (el.version ?? 0) + 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    updated: Date.now(),
  };
}

/**
 * `el` with its object set, or removed with `null`. Raises `version` for the
 * reason `withChild` does: Excalidraw and the save signature compare it.
 */
export function withObject(el: SceneElement, obj: FrameObject | null): SceneElement {
  const custom = { ...((el.customData as Record<string, unknown> | undefined) ?? {}) };
  const kaava = { ...((custom.kaava as Record<string, unknown> | undefined) ?? {}) };
  if (obj === null) delete kaava.object;
  else kaava.object = obj;
  if (Object.keys(kaava).length > 0) custom.kaava = kaava;
  else delete custom.kaava;
  return touched(el, { customData: Object.keys(custom).length > 0 ? custom : undefined });
}

export function withName(el: SceneElement, name: string): SceneElement {
  return touched(el, { name });
}

// --- values -------------------------------------------------------------------

/** The value a field starts with: its default, or the kind's empty. */
export function initialValue(field: FieldDef): unknown {
  if (field.default !== undefined && field.default !== null) return field.default;
  switch (field.kind) {
    case "bool":
      return false;
    case "path-list":
      return [];
    case "enum":
      return field.options?.[0] ?? "";
    case "number":
      return null;
    default:
      return "";
  }
}

/** The value shown for `field`: the stored one, else the initial one. */
export function valueOf(field: FieldDef, props: Record<string, unknown>): unknown {
  const stored = props[field.key];
  if (stored === undefined || stored === null) return initialValue(field);
  return stored;
}

/** The props a new object of `def` starts with: every default that is set. */
export function defaultProps(def: TypeDef): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (f.default !== undefined && f.default !== null) props[f.key] = f.default;
  }
  return props;
}

/**
 * The object after changing a frame to type `def`. Every stored value is kept,
 * including those the new type has no field for: they are invisible in the
 * inspector but stay in the file, so switching back loses nothing. A field the
 * new type has that is unset gets its default.
 */
export function changeType(current: FrameObject | null, def: TypeDef): FrameObject {
  const props = { ...(current?.props ?? {}) };
  for (const f of def.fields) {
    const has = props[f.key] !== undefined && props[f.key] !== null;
    if (!has && f.default !== undefined && f.default !== null) props[f.key] = f.default;
  }
  return { type: def.id, props };
}

export function setProp(obj: FrameObject, key: string, value: unknown): FrameObject {
  const props = { ...obj.props };
  if (value === null || value === undefined) delete props[key];
  else props[key] = value;
  return { ...obj, props };
}

/** A field's value as the text the input shows. */
export function fieldText(field: FieldDef, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (field.kind === "path-list") return Array.isArray(value) ? value.join("\n") : "";
  return String(value);
}

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

/** What the person typed, as the field's value; empty is "unset" (`null`). */
export function parseInput(field: FieldDef, text: string): Parsed {
  switch (field.kind) {
    case "number": {
      if (text.trim() === "") return { ok: true, value: null };
      const n = Number(text);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: "Enter a number." };
    }
    case "path-list": {
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
      return { ok: true, value: lines };
    }
    case "bool":
      return { ok: true, value: text === "true" };
    case "enum":
      return field.options?.includes(text)
        ? { ok: true, value: text }
        : { ok: false, error: "Pick one of the options." };
    default:
      return { ok: true, value: text };
  }
}

// --- the model type's spec-card export ------------------------------------------

const isStatus = (v: unknown): v is SpecStatus =>
  typeof v === "string" && (STATUSES as readonly string[]).includes(v);

/** A model frame's values as the form the cloud export (`spec.ts`) validates. */
export function modelDraft(name: string, props: Record<string, unknown>): SpecDraft {
  const refs = Array.isArray(props.reference_images)
    ? props.reference_images.filter((x): x is string => typeof x === "string")
    : [];
  const asset = typeof props.asset_name === "string" ? props.asset_name.trim() : "";
  return {
    ...EMPTY_DRAFT,
    name: asset || name,
    reference_images: refs.join("\n"),
    size_m: typeof props.size_m === "number" ? String(props.size_m) : "",
    triangle_budget: typeof props.triangle_budget === "number" ? String(props.triangle_budget) : "",
    style_notes: typeof props.style_notes === "string" ? props.style_notes : "",
    status: isStatus(props.review_state) ? props.review_state : "draft",
  };
}

// --- what is selected -------------------------------------------------------------

/** A spec card on an element that is not a frame, as stored. */
export function legacyCardOf(el: SceneElement): { name: string } | null {
  if (el.isDeleted || isFrame(el)) return null;
  const spec = (el.customData as { kaava?: { spec?: unknown } } | undefined)?.kaava?.spec;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  const name = (spec as { name?: unknown }).name;
  return { name: typeof name === "string" ? name : "" };
}

export interface FrameSummary {
  id: string;
  name: string;
  type: string | null;
}

/** The frame an element is inside, or `null`; a bound label counts as its container's. */
export function parentFrameOf(
  elements: readonly SceneElement[],
  el: SceneElement,
): SceneElement | null {
  let frameId = el.frameId;
  if (typeof frameId !== "string" && typeof el.containerId === "string") {
    const container = elements.find((e) => e.id === el.containerId);
    frameId = container?.frameId;
  }
  if (typeof frameId !== "string") return null;
  const parent = elements.find((e) => e.id === frameId && !e.isDeleted);
  return parent && isFrame(parent) ? parent : null;
}

/** What the inspector shows for the current selection. */
export type Target =
  | { kind: "none" }
  | { kind: "frame"; id: string; name: string; object: FrameObject | null; child: string | null }
  | { kind: "shape"; id: string; frame: FrameSummary | null; legacy: { name: string } | null }
  | { kind: "many"; count: number; wrappable: boolean };

function selectedIds(selected: Record<string, unknown> | undefined): string[] {
  return Object.keys(selected ?? {}).filter((id) => selected?.[id]);
}

export function targetOf(
  elements: readonly SceneElement[],
  selected: Record<string, unknown> | undefined,
): Target {
  const ids = selectedIds(selected);
  const picked = ids
    .map((id) => elements.find((e) => e.id === id))
    .filter((e): e is SceneElement => !!e && !e.isDeleted);
  if (picked.length === 0) return { kind: "none" };
  if (picked.length > 1) {
    return { kind: "many", count: picked.length, wrappable: !picked.some(isFrame) };
  }
  const el = picked[0]!;
  if (isFrame(el)) {
    const child = (el.customData as { kaava?: { child?: unknown } } | undefined)?.kaava?.child;
    return {
      kind: "frame",
      id: el.id,
      name: typeof el.name === "string" ? el.name : "",
      object: objectOf(el),
      child: typeof child === "string" && child !== "" ? child : null,
    };
  }
  const parent = parentFrameOf(elements, el);
  return {
    kind: "shape",
    id: el.id,
    frame: parent
      ? {
          id: parent.id,
          name: typeof parent.name === "string" ? parent.name : "",
          type: objectOf(parent)?.type ?? null,
        }
      : null,
    legacy: legacyCardOf(el),
  };
}

// --- clustering -------------------------------------------------------------------

const PADDING = 24;

export function randomId(): string {
  let id = "";
  while (id.length < 21) id += Math.random().toString(36).slice(2);
  return id.slice(0, 21);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The box an element covers; a line or arrow by its points, not its first point. */
function boxOf(el: SceneElement): Box {
  const x = Number(el.x) || 0;
  const y = Number(el.y) || 0;
  const points = el.points as [number, number][] | undefined;
  if (Array.isArray(points) && points.length > 0) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      x: x + minX,
      y: y + minY,
      width: Math.max(...xs) - minX,
      height: Math.max(...ys) - minY,
    };
  }
  return { x, y, width: Number(el.width) || 0, height: Number(el.height) || 0 };
}

export function frameElement(box: Box, name: string, extra: Record<string, unknown> = {}) {
  const id = randomId();
  return {
    id,
    type: "frame",
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    angle: 0,
    strokeColor: "#bbb",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    name,
    ...extra,
  } as SceneElement;
}

export type Wrapped =
  { ok: true; elements: SceneElement[]; frameId: string } | { ok: false; error: string };

/**
 * The scene with the selected shapes inside a new labelled frame: the frame is
 * sized to them plus padding, and each shape (and bound label) takes the frame
 * as its `frameId`. The frame goes last, after its children, which is where
 * Excalidraw keeps it. Frames cannot nest, so a selection holding one is refused.
 */
export function wrapSelection(
  elements: readonly SceneElement[],
  selected: Record<string, unknown> | undefined,
  name = "New frame",
): Wrapped {
  const picked = new Set(selectedIds(selected));
  const live = elements.filter((e) => !e.isDeleted);
  const chosen = live.filter((e) => picked.has(e.id));
  if (chosen.length === 0)
    return { ok: false, error: "Select the shapes to put in a frame first." };
  if (chosen.some(isFrame)) {
    return { ok: false, error: "Frames cannot be nested. Select plain shapes, not a frame." };
  }
  const members = new Set(
    live
      .filter(
        (e) => picked.has(e.id) || (typeof e.containerId === "string" && picked.has(e.containerId)),
      )
      .map((e) => e.id),
  );
  const boxes = live.filter((e) => members.has(e.id)).map(boxOf);
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  const frame = frameElement(
    {
      x: left - PADDING,
      y: top - PADDING,
      width: right - left + 2 * PADDING,
      height: bottom - top + 2 * PADDING,
    },
    name,
  );
  const next = elements.map((e) =>
    members.has(e.id) && !e.isDeleted ? touched(e, { frameId: frame.id }) : e,
  );
  return { ok: true, elements: [...next, frame], frameId: frame.id };
}

/**
 * Turn the spec card on a plain shape into a model frame around that shape:
 * the card's fields become the object's values and the card is removed from the
 * shape, so nothing is lost and nothing is shown twice.
 */
export function convertLegacy(elements: readonly SceneElement[], id: string): Wrapped {
  const el = elements.find((e) => e.id === id && !e.isDeleted);
  const spec = (el?.customData as { kaava?: { spec?: Record<string, unknown> } } | undefined)?.kaava
    ?.spec;
  if (!el || !spec) return { ok: false, error: "That shape has no spec card." };
  const wrapped = wrapSelection(elements, { [id]: true }, String(spec.name || "Model"));
  if (!wrapped.ok) return wrapped;
  const props: Record<string, unknown> = {};
  for (const key of ["size_m", "triangle_budget", "style_notes", "reference_images"]) {
    if (spec[key] !== undefined) props[key] = spec[key];
  }
  props.review_state = isStatus(spec.status) ? spec.status : "draft";
  const out = wrapped.elements.map((e) => {
    if (e.id === wrapped.frameId) return withObject(e, { type: "model", props });
    if (e.id !== id) return e;
    const custom = { ...(e.customData as Record<string, unknown>) };
    const kaava = { ...(custom.kaava as Record<string, unknown>) };
    delete kaava.spec;
    if (Object.keys(kaava).length > 0) custom.kaava = kaava;
    else delete custom.kaava;
    return touched(e, { customData: Object.keys(custom).length > 0 ? custom : undefined });
  });
  return { ok: true, elements: out, frameId: wrapped.frameId };
}
