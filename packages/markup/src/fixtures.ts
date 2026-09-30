/** Builders for the tests. Plain data shaped like Excalidraw elements. */
import type { CameraPose, MarkupElement } from "./types";

export function el(over: Partial<MarkupElement> & { id: string; type: string }): MarkupElement {
  return { x: 0, y: 0, width: 10, height: 10, version: 1, ...over };
}

export function arrow(id: string, x: number, y: number, dx: number, dy: number): MarkupElement {
  return el({
    id,
    type: "arrow",
    x,
    y,
    width: Math.abs(dx),
    height: Math.abs(dy),
    points: [
      [0, 0],
      [dx, dy],
    ],
    startArrowhead: null,
    endArrowhead: "arrow",
  });
}

/** A pin the way the layer stores it: marker plus bound label. */
export function pin(n: number, cx: number, cy: number, worldPoint?: [number, number, number]) {
  const kaava: Record<string, unknown> = { kind: "pin", n, note: `note ${n}` };
  if (worldPoint) {
    kaava.nodePath = `Root/Node${n}`;
    kaava.worldPoint = worldPoint;
  }
  return [
    el({
      id: `m${n}`,
      type: "ellipse",
      x: cx - 16,
      y: cy - 16,
      width: 32,
      height: 32,
      customData: { kaava },
    }),
    el({
      id: `l${n}`,
      type: "text",
      x: cx - 4,
      y: cy - 8,
      text: String(n),
      containerId: `m${n}`,
      customData: { kaava: { kind: "pin-label", n } },
    }),
  ];
}

export function pose(x: number, fov = 50): CameraPose {
  return { position: [x, 2, 5], target: [0, 0, 0], up: [0, 1, 0], fov };
}
