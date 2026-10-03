/**
 * Which node an annotation points at. An arrow points at what its head lands
 * on; a rectangle or ellipse points at what is under its centre. The host does
 * the picking (`MarkupHost.pick`), this module only decides where to ask.
 */
import { kaavaData, touch } from "./elements";
import type { MarkupElement, MarkupHost, MarkupTarget } from "./types";

export interface TargetPoint {
  at: "head" | "centre";
  x: number;
  y: number;
}

/**
 * Where an element asks "what is here?", or null for elements that do not
 * point at anything (freehand ink, text, pins, a bare line).
 */
export function targetPoint(el: MarkupElement): TargetPoint | null {
  if (el.isDeleted) return null;
  if (el.type === "arrow") {
    const pts = el.points;
    if (!pts || pts.length < 2) return null;
    const useStart = el.endArrowhead == null && el.startArrowhead != null;
    const p = useStart ? pts[0] : pts[pts.length - 1];
    return { at: "head", x: el.x + p[0], y: el.y + p[1] };
  }
  if (el.type === "rectangle" || el.type === "ellipse") {
    return { at: "centre", x: el.x + el.width / 2, y: el.y + el.height / 2 };
  }
  return null;
}

/** The targets of one element: empty when the host cannot pick or nothing is hit. */
export function resolveTargets(
  el: MarkupElement,
  pick: MarkupHost["pick"] | undefined,
): MarkupTarget[] {
  if (!pick) return [];
  const at = targetPoint(el);
  if (!at) return [];
  const hit = pick(at.x, at.y);
  return hit ? [{ nodePath: hit.nodePath, worldPoint: hit.worldPoint, at: at.at }] : [];
}

/**
 * Stamps `customData.kaava = { kind, targets? }` on every arrow and box, and
 * `{ kind }` on other ink. Idempotent: an element whose stamp would not change
 * is returned as it was, so calling this before every export does not bump
 * versions and does not look like an edit to a saver.
 */
export function annotateTargets(
  elements: readonly MarkupElement[],
  pick: MarkupHost["pick"] | undefined,
): MarkupElement[] {
  return elements.map((el) => {
    if (el.isDeleted || el.containerId) return el;
    const existing = kaavaData(el);
    if (existing && (existing.kind === "pin" || existing.kind === "pin-label")) return el;
    const targets = resolveTargets(el, pick);
    const next: Record<string, unknown> = { ...existing, kind: el.type };
    delete next.targets;
    if (targets.length > 0) next.targets = targets;
    if (JSON.stringify(next) === JSON.stringify(existing)) return el;
    return touch(el, { customData: { ...el.customData, kaava: next } });
  });
}
