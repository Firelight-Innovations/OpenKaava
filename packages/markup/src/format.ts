/**
 * The markup JSON: the one format the 3D viewer and the Canvas both read.
 * `docs/markup-format.md` is the agent-facing description; this file is the
 * code that writes it.
 */
import { kaavaData, live } from "./elements";
import { isPinPart, listPins } from "./pins";
import type { CameraPose, MarkupElement, MarkupHost, MarkupTarget, Vec3 } from "./types";

export const MARKUP_VERSION = 1;

export interface MarkupPinJson {
  n: number;
  note: string;
  nodePath?: string;
  worldPoint?: Vec3;
}

export interface MarkupAnnotationJson {
  /** The Excalidraw element type: "arrow", "rectangle", "ellipse", "freedraw", "text", "line", "diamond". */
  kind: string;
  /** The text of a text element, or of the label bound to a shape or arrow. */
  text?: string;
  targets?: MarkupTarget[];
  /** Where it is, in host viewport pixels. */
  bounds: { x: number; y: number; width: number; height: number };
}

export interface MarkupJson {
  version: 1;
  /** `host.describe()`: what the frame is. */
  source: Record<string, unknown>;
  /** The host viewport in CSS pixels; the scene coordinates of `excalidraw` are 1:1 with it. */
  size: { width: number; height: number };
  camera?: CameraPose;
  pins: MarkupPinJson[];
  annotations: MarkupAnnotationJson[];
  excalidraw: {
    elements: MarkupElement[];
    appState: { viewBackgroundColor: string };
  };
}

export interface BuildInput {
  host: Pick<MarkupHost, "describe" | "size">;
  /** Everything on screen: ink and pins. Deleted elements are dropped here. */
  elements: readonly MarkupElement[];
  camera?: CameraPose | null;
}

function targetsOf(el: MarkupElement): MarkupTarget[] | undefined {
  const t = kaavaData(el)?.targets;
  return Array.isArray(t) && t.length > 0 ? (t as MarkupTarget[]) : undefined;
}

/** Assembles the JSON. Pure: the caller has already stamped targets (`annotateTargets`). */
export function buildMarkupJson(input: BuildInput): MarkupJson {
  const elements = live(input.elements);
  const labels = new Map<string, string>();
  for (const el of elements) {
    if (el.type === "text" && el.containerId && !isPinPart(el) && typeof el.text === "string") {
      labels.set(el.containerId, el.text);
    }
  }

  const pins: MarkupPinJson[] = listPins(elements).map((p) => {
    const pin: MarkupPinJson = { n: p.n, note: p.note };
    if (p.nodePath !== undefined) pin.nodePath = p.nodePath;
    if (p.worldPoint !== undefined) pin.worldPoint = p.worldPoint;
    return pin;
  });

  const annotations: MarkupAnnotationJson[] = [];
  for (const el of elements) {
    if (isPinPart(el) || el.containerId) continue;
    const item: MarkupAnnotationJson = {
      kind: el.type,
      bounds: { x: el.x, y: el.y, width: el.width, height: el.height },
    };
    const text = el.type === "text" ? el.text : labels.get(el.id);
    if (typeof text === "string" && text !== "") item.text = text;
    const targets = targetsOf(el);
    if (targets) item.targets = targets;
    annotations.push(item);
  }

  const json: MarkupJson = {
    version: MARKUP_VERSION,
    source: input.host.describe(),
    size: input.host.size(),
    pins,
    annotations,
    excalidraw: {
      elements,
      appState: { viewBackgroundColor: "transparent" },
    },
  };
  if (input.camera) json.camera = input.camera;
  return json;
}

/** Type guard for a value read from disk or a message. */
export function isMarkupJson(value: unknown): value is MarkupJson {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === MARKUP_VERSION &&
    typeof v.source === "object" &&
    v.source !== null &&
    Array.isArray(v.pins) &&
    Array.isArray(v.annotations) &&
    typeof v.excalidraw === "object" &&
    v.excalidraw !== null &&
    Array.isArray((v.excalidraw as { elements?: unknown }).elements)
  );
}
