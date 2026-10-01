/**
 * `add_shapes`: the drawing API. A declarative description in, placed and
 * measured Excalidraw elements out, inside one named frame.
 *
 * An agent says what it wants ("a box labelled Ready at 0,0; an arrow from
 * Ready to Playing labelled tap") and this decides the sizes. Every label is
 * measured with the real font through the injected `LineWidth`, boxes grow to
 * fit their labels, positions snap to a 10 px grid, and text that would land
 * on other text or across a filled shape is moved clear and reported. The
 * frame is sized to its content, so nothing is cut off at its edge.
 *
 * Ids are `<diagram>:<shape>`, so an agent that drew `ready` in `states` can
 * refer to `states:ready` later, and a rebuild of the frame (`replace`, the
 * default) produces the same ids and therefore a readable diff.
 *
 * Rejected: a general constraint solver (dagre, ELK). Diagrams here are drawn
 * to scale as often as they are graphs, and a solver would move a pillar that
 * must sit at x = 10.5 units. Mermaid import (`mermaid.ts`) covers the graphs.
 */
import {
  BOUND_TEXT_PADDING,
  LINE_HEIGHT,
  PALETTE,
  TEXT_SIZE,
  TRANSPARENT,
  bind,
  colour,
  frame as frameElement,
  image as imageElement,
  linear,
  shape as shapeElement,
  text as textElement,
  type Binding,
  type Element,
  type PaletteName,
  type TextSize,
} from "./draw";

export type Level = "index" | "overview" | "subsystem" | "detail";

export interface FrameSpec {
  id: string;
  title: string;
  summary?: string;
  parent?: string;
  level?: Level;
  covers?: string[];
  /** Scene position of the frame's top-left; placed right of the others if unset. */
  x?: number;
  y?: number;
  /** Fixed size; the frame fits its content when unset. */
  width?: number;
  height?: number;
}

export type Point = [number, number];

export interface ShapeSpec {
  id: string;
  type: "rectangle" | "ellipse" | "diamond" | "text" | "arrow" | "line" | "image";
  /** Content coordinates: relative to the frame's content area, below its title. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** A shape's label, or an arrow's. */
  label?: string;
  /** A text element's text. `{{name}}` is filled from the canvas's values. */
  text?: string;
  size?: TextSize;
  color?: PaletteName;
  /** A palette name to fill with its light shade, `solid` for the stroke colour, or `none`. */
  fill?: PaletteName | "solid" | "none";
  dashed?: boolean;
  strokeWidth?: number;
  rounded?: boolean;
  /** Text: which edge `x` names. */
  align?: "left" | "center" | "right";
  /** Text: which edge `y` names. */
  valign?: "top" | "middle" | "bottom";
  /** Text: wrap to this width. */
  maxWidth?: number;
  /** Arrow/line: a shape id in this spec, or a point. */
  from?: string | Point;
  to?: string | Point;
  /** Arrow/line: every point, in content coordinates. Overrides from/to geometry. */
  points?: Point[];
  curved?: boolean;
  head?: "arrow" | "triangle" | "dot" | "bar" | "none";
  tail?: "arrow" | "triangle" | "dot" | "bar" | "none";
  /** Image: a file under the canvas's refs folder, `refs/<file>`. */
  ref?: string;
  /** Leave this element where it was put even if it overlaps. */
  fixed?: boolean;
  /** A link opened on click: `kaava://diagram/<id>` moves to that diagram. */
  link?: string;
}

export interface AddShapesSpec {
  frame: FrameSpec;
  shapes: ShapeSpec[];
  /** Drop the frame's previous contents first (default true). */
  replace?: boolean;
  /** Move overlapping text clear (default true); false only reports it. */
  nudge?: boolean;
  /** Values to add to the canvas's table before `{{name}}` is filled. */
  values?: Record<string, unknown>;
}

/** The width of one line of text at a font size, in px. */
export type LineWidth = (line: string, fontSize: number) => number;

export interface LayoutResult {
  elements: Element[];
  ids: Record<string, string>;
  frame: {
    id: string;
    elementId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    /** Where content coordinates 0,0 fall in the scene. */
    origin: [number, number];
  };
  warnings: string[];
}

export const GRID = 10;
export const FRAME_PAD = 40;
const HEADER_GAP = 24;
const ARROW_GAP = 6;
const FRAME_SPACING = 120;
const LABEL_PAD_X = 16;
const LABEL_PAD_Y = 10;

const snap = (v: number) => Math.round(v / GRID) * GRID;
const snapUp = (v: number) => Math.ceil(v / GRID) * GRID;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const overlapArea = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

/** Greedy word wrap to `max` px; a word longer than a line stays whole. */
export function wrap(textIn: string, fontSize: number, max: number, width: LineWidth): string {
  const out: string[] = [];
  for (const para of textIn.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && width(next, fontSize) > max) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

export function measure(textIn: string, fontSize: number, width: LineWidth) {
  const lines = textIn.split("\n");
  return {
    width: Math.ceil(Math.max(0, ...lines.map((l) => width(l, fontSize)))),
    height: Math.ceil(lines.length * fontSize * LINE_HEIGHT),
  };
}

/** Fill `{{name}}` from `values`; unknown names are left as written. */
export function fillTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (whole, name: string) => {
    const entry = values[name];
    if (entry === undefined) return whole;
    const v =
      entry !== null && typeof entry === "object" && "value" in entry
        ? (entry as { value: unknown }).value
        : entry;
    return typeof v === "number" && Number.isInteger(v) ? String(v) : String(v);
  });
}

function fillOf(s: ShapeSpec): string {
  if (!s.fill || s.fill === "none") return TRANSPARENT;
  if (s.fill === "solid") return colour(s.color).stroke;
  return colour(s.fill).fill;
}

/** Where the line from a shape's centre towards `toward` leaves its outline. */
function edgePoint(kind: string, b: Box, toward: Point): Point {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const dx = toward[0] - cx;
  const dy = toward[1] - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const a = b.width / 2 + ARROW_GAP;
  const h = b.height / 2 + ARROW_GAP;
  let t: number;
  if (kind === "ellipse") t = 1 / Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (h * h));
  else if (kind === "diamond") t = 1 / (Math.abs(dx) / a + Math.abs(dy) / h);
  else t = Math.min(dx === 0 ? Infinity : a / Math.abs(dx), dy === 0 ? Infinity : h / Math.abs(dy));
  return [cx + dx * t, cy + dy * t];
}

/** The widest a bound label may be inside a container, as Excalidraw computes it. */
function labelRoom(kind: string, w: number, h: number) {
  if (kind === "ellipse")
    return {
      w: Math.round((w / 2) * Math.SQRT2) - BOUND_TEXT_PADDING * 2,
      h: Math.round((h / 2) * Math.SQRT2) - BOUND_TEXT_PADDING * 2,
    };
  if (kind === "diamond")
    return {
      w: Math.round(w / 2) - BOUND_TEXT_PADDING * 2,
      h: Math.round(h / 2) - BOUND_TEXT_PADDING * 2,
    };
  return { w: w - BOUND_TEXT_PADDING * 2, h: h - BOUND_TEXT_PADDING * 2 };
}

/** The container size that fits a label of `tw` x `th`. */
function sizeFor(kind: string, tw: number, th: number) {
  const w = tw + 2 * LABEL_PAD_X;
  const h = th + 2 * LABEL_PAD_Y;
  if (kind === "ellipse") return { w: snapUp(w * Math.SQRT2), h: snapUp(h * Math.SQRT2) };
  if (kind === "diamond") return { w: snapUp(w * 2), h: snapUp(h * 2) };
  return { w: snapUp(Math.max(w, 60)), h: snapUp(Math.max(h, 40)) };
}

function frameMeta(f: FrameSpec): Record<string, unknown> {
  const meta: Record<string, unknown> = { id: f.id, title: f.title };
  if (f.summary) meta.summary = f.summary;
  if (f.parent) meta.parent = f.parent;
  if (f.level) meta.level = f.level;
  if (f.covers?.length) meta.covers = f.covers;
  return meta;
}

const HEADS: Record<string, string | null> = {
  arrow: "arrow",
  triangle: "triangle",
  dot: "dot",
  bar: "bar",
  none: null,
};

const DIAGRAM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHAPE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function diagramOf(el: Element): Record<string, unknown> | null {
  const kaava = (el.customData as { kaava?: { diagram?: unknown } } | undefined)?.kaava;
  const d = kaava?.diagram;
  return d && typeof d === "object" ? (d as Record<string, unknown>) : null;
}

/**
 * Lay `spec` out into `scene` (the scene's elements) and return the new
 * element list. Pure: the only outside input is `width`.
 */
export function addShapes(
  scene: readonly Element[],
  spec: AddShapesSpec,
  width: LineWidth,
  values: Record<string, unknown> = {},
  files: Record<string, { kaavaRef?: string }> = {},
): LayoutResult {
  const f = spec.frame;
  if (!f || typeof f.id !== "string" || !DIAGRAM_ID.test(f.id))
    throw new Error("frame.id is required: lowercase letters, digits and -, e.g. `flap-timing`");
  if (!f.title || typeof f.title !== "string") throw new Error("frame.title is required");
  if (!Array.isArray(spec.shapes)) throw new Error("shapes must be an array");
  const warnings: string[] = [];
  const table = { ...values, ...(spec.values ?? {}) };
  const frameId = `frame:${f.id}`;
  const prefix = `${f.id}:`;

  // Where the frame goes: where it was, where asked, or right of the others.
  const existing = scene.find(
    (el) =>
      el.type === "frame" && !el.isDeleted && (el.id === frameId || diagramOf(el)?.id === f.id),
  );
  const others = scene.filter((el) => el.type === "frame" && !el.isDeleted && el !== existing);
  let fx = f.x ?? (existing?.x as number | undefined);
  let fy = f.y ?? (existing?.y as number | undefined);
  if (fx === undefined || fy === undefined) {
    const right = Math.max(0, ...others.map((o) => (o.x as number) + (o.width as number)));
    fx = fx ?? (others.length ? snap(right + FRAME_SPACING) : 0);
    fy = fy ?? (others.length ? Math.min(...others.map((o) => o.y as number)) : 0);
  }
  const realFrameId = existing ? existing.id : frameId;

  // Keep everything that is not this frame's, unless adding to it.
  const replace = spec.replace !== false;
  const kept = scene.filter((el) => {
    if (el === existing) return false;
    if (!replace) return true;
    return el.frameId !== realFrameId && !String(el.id).startsWith(prefix);
  });
  const survivors = new Set(kept.map((el) => el.id));
  const carried = replace
    ? []
    : scene.filter((el) => el.frameId === realFrameId && survivors.has(el.id));
  for (const el of carried) survivors.delete(el.id);

  // The header: title and summary, measured.
  const out: Element[] = [];
  const titleSize = TEXT_SIZE.title;
  const title = measure(f.title, titleSize, width);
  out.push(
    textElement({
      id: `${prefix}_title`,
      x: fx + FRAME_PAD,
      y: fy + FRAME_PAD,
      width: title.width,
      height: title.height,
      frameId: realFrameId,
      text: f.title,
      fontSize: titleSize,
    }),
  );
  let headerBottom = fy + FRAME_PAD + title.height;
  let headerWidth = title.width;
  if (f.summary) {
    const s = wrap(f.summary, TEXT_SIZE.body, 720, width);
    const m = measure(s, TEXT_SIZE.body, width);
    out.push(
      textElement({
        id: `${prefix}_summary`,
        x: fx + FRAME_PAD,
        y: headerBottom + 6,
        width: m.width,
        height: m.height,
        frameId: realFrameId,
        text: s,
        fontSize: TEXT_SIZE.body,
        stroke: PALETTE.muted.stroke,
      }),
    );
    headerBottom += 6 + m.height;
    headerWidth = Math.max(headerWidth, m.width);
  }
  const ox = fx + FRAME_PAD;
  const oy = snapUp(headerBottom + HEADER_GAP);

  const ids: Record<string, string> = {};
  const placed = new Map<string, { el: Element; box: Box; kind: string }>();
  const texts: { el: Element; fixed: boolean; owner: string }[] = [];
  const solids: { el: Element; box: Box }[] = [];
  const seen = new Set<string>();

  // Shapes and free text first, so arrows can find what they point at.
  for (const s of spec.shapes) {
    if (!s || typeof s.id !== "string" || !SHAPE_ID.test(s.id))
      throw new Error(
        `every shape needs an id of letters, digits, - and _ (got ${JSON.stringify(s?.id)})`,
      );
    if (seen.has(s.id)) throw new Error(`shape id \`${s.id}\` is used twice`);
    seen.add(s.id);
    const id = `${prefix}${s.id}`;
    ids[s.id] = id;
    const stroke = colour(s.color).stroke;
    const size = TEXT_SIZE[s.size ?? "body"] ?? TEXT_SIZE.body;
    if (s.type === "rectangle" || s.type === "ellipse" || s.type === "diamond") {
      const x = ox + (s.x ?? 0);
      const y = oy + (s.y ?? 0);
      let w = s.width;
      let h = s.height;
      let label = s.label ? fillTemplate(s.label, table) : "";
      let lm = label ? measure(label, size, width) : { width: 0, height: 0 };
      if (label && w !== undefined) {
        const room = labelRoom(s.type, w, h ?? 1e6).w;
        if (lm.width > room) {
          label = wrap(label, size, room, width);
          lm = measure(label, size, width);
          if (lm.width > room) {
            warnings.push(`\`${s.id}\`: a word in the label is wider than the shape; widened it`);
            w = undefined;
          }
        }
      }
      const auto = sizeFor(s.type, lm.width, lm.height);
      w = w ?? (label ? auto.w : 100);
      h = h ?? (label ? auto.h : 60);
      if (label && lm.height > labelRoom(s.type, w, h).h) {
        warnings.push(`\`${s.id}\`: the label is taller than the shape; made it taller`);
        h = sizeFor(s.type, lm.width, lm.height).h;
      }
      const el = shapeElement(s.type, {
        id,
        x,
        y,
        width: w,
        height: h,
        frameId: realFrameId,
        stroke,
        fill: fillOf(s),
        dashed: s.dashed,
        strokeWidth: s.strokeWidth,
        rounded: s.rounded,
        node: s.id,
      });
      if (s.link) el.link = s.link;
      out.push(el);
      const box = { x, y, width: w, height: h };
      placed.set(s.id, { el, box, kind: s.type });
      if (el.backgroundColor !== TRANSPARENT) solids.push({ el, box });
      if (label) {
        const t = textElement({
          id: `${id}:label`,
          x: x + w / 2 - lm.width / 2,
          y: y + h / 2 - lm.height / 2,
          width: lm.width,
          height: lm.height,
          frameId: realFrameId,
          text: label,
          fontSize: size,
          align: "center",
          verticalAlign: "middle",
          containerId: id,
          stroke: s.fill === "solid" ? PALETTE.ink.fill : stroke,
        });
        if (s.label && s.label !== label && /\{\{/.test(s.label))
          t.customData = { kaava: { template: s.label } };
        bind(el, t, "text");
        out.push(t);
        texts.push({ el: t, fixed: true, owner: id });
      }
    } else if (s.type === "text") {
      const raw = s.text ?? s.label ?? "";
      if (!raw) throw new Error(`text \`${s.id}\` has no text`);
      let body = fillTemplate(raw, table);
      if (s.maxWidth) body = wrap(body, size, s.maxWidth, width);
      const m = measure(body, size, width);
      const ax = ox + (s.x ?? 0);
      const ay = oy + (s.y ?? 0);
      const x = s.align === "center" ? ax - m.width / 2 : s.align === "right" ? ax - m.width : ax;
      const y =
        s.valign === "middle" ? ay - m.height / 2 : s.valign === "bottom" ? ay - m.height : ay;
      const el = textElement({
        id,
        x,
        y,
        width: m.width,
        height: m.height,
        frameId: realFrameId,
        text: body,
        fontSize: size,
        align: s.align ?? "left",
        stroke,
        node: s.id,
      });
      const kaava: Record<string, unknown> = { node: s.id };
      if (/\{\{/.test(raw)) kaava.template = raw;
      el.customData = { kaava };
      if (s.link) el.link = s.link;
      out.push(el);
      placed.set(s.id, { el, box: { x, y, width: m.width, height: m.height }, kind: "text" });
      texts.push({ el, fixed: !!s.fixed, owner: id });
    } else if (s.type === "image") {
      const ref = s.ref ?? "";
      const fileId = Object.keys(files).find((k) => files[k]?.kaavaRef === ref);
      if (!fileId)
        throw new Error(`image \`${s.id}\`: no reference image \`${ref}\` on this canvas`);
      const el = imageElement({
        id,
        x: ox + (s.x ?? 0),
        y: oy + (s.y ?? 0),
        width: s.width ?? 200,
        height: s.height ?? 150,
        frameId: realFrameId,
        fileId,
        node: s.id,
      });
      out.push(el);
      placed.set(s.id, {
        el,
        box: {
          x: el.x as number,
          y: el.y as number,
          width: el.width as number,
          height: el.height as number,
        },
        kind: "image",
      });
    } else if (s.type !== "arrow" && s.type !== "line") {
      throw new Error(`shape \`${s.id}\` has unknown type \`${String(s.type)}\``);
    }
  }

  // Then arrows and lines, bound to what they join.
  for (const s of spec.shapes) {
    if (s.type !== "arrow" && s.type !== "line") continue;
    const id = ids[s.id]!;
    const end = (
      ref: string | Point | undefined,
      other: Point | null,
    ): { p: Point; bindTo?: Element } | null => {
      if (ref === undefined) return null;
      if (Array.isArray(ref)) return { p: [ox + ref[0], oy + ref[1]] };
      const hit = placed.get(ref);
      if (!hit)
        throw new Error(`\`${s.id}\` points at \`${ref}\`, which is not a shape in this spec`);
      const c: Point = [hit.box.x + hit.box.width / 2, hit.box.y + hit.box.height / 2];
      return { p: other ? edgePoint(hit.kind, hit.box, other) : c, bindTo: hit.el };
    };
    let abs: Point[];
    let start: { p: Point; bindTo?: Element } | null = null;
    let finish: { p: Point; bindTo?: Element } | null = null;
    if (s.points && s.points.length >= 2) {
      abs = s.points.map(([x, y]) => [ox + x, oy + y] as Point);
      if (typeof s.from === "string") start = { p: abs[0]!, bindTo: placed.get(s.from)?.el };
      if (typeof s.to === "string")
        finish = { p: abs[abs.length - 1]!, bindTo: placed.get(s.to)?.el };
    } else {
      const centre = (ref: string | Point | undefined): Point | null => {
        if (ref === undefined) return null;
        if (Array.isArray(ref)) return [ox + ref[0], oy + ref[1]];
        const hit = placed.get(ref);
        if (!hit)
          throw new Error(`\`${s.id}\` points at \`${ref}\`, which is not a shape in this spec`);
        return [hit.box.x + hit.box.width / 2, hit.box.y + hit.box.height / 2];
      };
      const a = centre(s.from);
      const b = centre(s.to);
      if (!a || !b)
        throw new Error(`\`${s.id}\` needs from and to (shape ids or [x, y]), or points`);
      start = end(s.from, b);
      finish = end(s.to, a);
      abs = [start!.p, finish!.p];
    }
    const [x0, y0] = abs[0]!;
    const binding = (e: { bindTo?: Element } | null): Binding | null =>
      e?.bindTo ? { elementId: e.bindTo.id, focus: 0, gap: ARROW_GAP } : null;
    const el = linear(s.type, {
      id,
      x: x0,
      y: y0,
      width: Math.max(...abs.map((p) => p[0])) - Math.min(...abs.map((p) => p[0])),
      height: Math.max(...abs.map((p) => p[1])) - Math.min(...abs.map((p) => p[1])),
      frameId: realFrameId,
      stroke: colour(s.color).stroke,
      dashed: s.dashed,
      strokeWidth: s.strokeWidth,
      points: abs.map(([x, y]) => [x - x0, y - y0] as Point),
      start: binding(start),
      end: binding(finish),
      startHead: s.tail ? HEADS[s.tail] : null,
      endHead: s.head ? HEADS[s.head] : s.type === "arrow" ? "arrow" : null,
      curved: s.curved,
      node: s.id,
    });
    if (start?.bindTo) bind(start.bindTo, el, "arrow");
    if (finish?.bindTo) bind(finish.bindTo, el, "arrow");
    out.push(el);
    if (s.label) {
      const size = TEXT_SIZE[s.size ?? "small"] ?? TEXT_SIZE.small;
      const label = fillTemplate(s.label, table);
      // An exported PNG cuts the arrow's line at exactly the label's box, so
      // the box carries the padding the editor adds; the text stays centred.
      const glyphs = measure(label, size, width);
      const m = { width: glyphs.width + BOUND_TEXT_PADDING * 2, height: glyphs.height };
      const mid = Math.floor((abs.length - 1) / 2);
      const p = abs[mid]!;
      const q = abs[mid + 1] ?? p;
      const cx = abs.length % 2 === 1 ? abs[mid]![0] : (p[0] + q[0]) / 2;
      const cy = abs.length % 2 === 1 ? abs[mid]![1] : (p[1] + q[1]) / 2;
      const t = textElement({
        id: `${id}:label`,
        x: cx - m.width / 2,
        y: cy - m.height / 2,
        width: m.width,
        height: m.height,
        frameId: realFrameId,
        text: label,
        fontSize: size,
        align: "center",
        verticalAlign: "middle",
        containerId: id,
        stroke: colour(s.color).stroke,
      });
      bind(el, t, "text");
      out.push(t);
      texts.push({ el: t, fixed: true, owner: id });
    }
  }

  // Clear text off other text and off filled shapes it only partly covers.
  const boxOf = (el: Element): Box => ({
    x: el.x as number,
    y: el.y as number,
    width: el.width as number,
    height: el.height as number,
  });
  const clash = (t: { el: Element; owner: string }, at: Box): string | null => {
    for (const o of texts) {
      if (o.el === t.el) continue;
      if (overlapArea(at, boxOf(o.el)) > 4) return o.owner.slice(prefix.length) || o.el.id;
    }
    for (const s of solids) {
      if (s.el.id === t.owner || s.el.id === t.el.containerId) continue;
      const area = overlapArea(at, s.box);
      if (area > 4 && !inside(at, s.box)) return s.el.id.slice(prefix.length);
    }
    return null;
  };
  const nudge = spec.nudge !== false;
  for (const t of texts) {
    const here = boxOf(t.el);
    const hit = clash(t, here);
    if (!hit) continue;
    const name = t.owner.slice(prefix.length);
    if (t.fixed || !nudge) {
      warnings.push(`\`${name}\` overlaps \`${hit}\``);
      continue;
    }
    let moved: [number, number] | null = null;
    search: for (let ring = 1; ring <= 8; ring++) {
      const d = ring * GRID;
      for (const [dx, dy] of [
        [0, d],
        [0, -d],
        [d, 0],
        [-d, 0],
        [d, d],
        [-d, d],
        [d, -d],
        [-d, -d],
      ] as const) {
        if (!clash(t, { ...here, x: here.x + dx, y: here.y + dy })) {
          moved = [dx, dy];
          break search;
        }
      }
    }
    if (moved) {
      t.el.x = here.x + moved[0];
      t.el.y = here.y + moved[1];
      warnings.push(`moved \`${name}\` by (${moved[0]}, ${moved[1]}) to clear \`${hit}\``);
    } else {
      warnings.push(`\`${name}\` overlaps \`${hit}\` and no free spot was found within 80 px`);
    }
  }

  // Size the frame to what is in it.
  let right = fx + FRAME_PAD + headerWidth;
  let bottom = oy;
  for (const el of [...out, ...carried]) {
    const b = boxOf(el);
    const pts = el.points as Point[] | undefined;
    if (pts) {
      for (const [px, py] of pts) {
        right = Math.max(right, b.x + px);
        bottom = Math.max(bottom, b.y + py);
      }
    } else {
      right = Math.max(right, b.x + b.width);
      bottom = Math.max(bottom, b.y + b.height);
    }
    if (b.x < fx || b.y < fy)
      warnings.push(`\`${String(el.id).slice(prefix.length)}\` starts above or left of the frame`);
  }
  const autoW = snapUp(right - fx + FRAME_PAD);
  const autoH = snapUp(bottom - fy + FRAME_PAD);
  const fw = f.width ?? autoW;
  const fh = f.height ?? autoH;
  if (f.width !== undefined && f.width < autoW - FRAME_PAD)
    warnings.push(
      `content is ${autoW - FRAME_PAD} px wide but frame.width is ${f.width}; it will be clipped`,
    );
  if (f.height !== undefined && f.height < autoH - FRAME_PAD)
    warnings.push(
      `content is ${autoH - FRAME_PAD} px tall but frame.height is ${f.height}; it will be clipped`,
    );
  const frameEl = frameElement({
    id: realFrameId,
    x: fx,
    y: fy,
    width: fw,
    height: fh,
    name: f.title,
    diagram: frameMeta(f),
    previous: existing,
  });

  // Children before their frame, the order Excalidraw draws frames in.
  const elements = [...kept, ...carried, ...out, frameEl];
  return {
    elements,
    ids,
    frame: {
      id: f.id,
      elementId: realFrameId,
      x: fx,
      y: fy,
      width: fw,
      height: fh,
      origin: [ox, oy],
    },
    warnings,
  };
}

export interface DiagramRow {
  id: string;
  title: string;
  summary: string;
  level: string | null;
  covers: string[];
}

/** Every named diagram on the canvas, index excluded, top level first. */
export function diagramsIn(scene: readonly Element[]): DiagramRow[] {
  const order: Record<string, number> = { overview: 0, subsystem: 1, detail: 2 };
  return scene
    .filter((el) => el.type === "frame" && !el.isDeleted)
    .map((el) => ({ el, d: diagramOf(el) }))
    .filter(({ d }) => d && typeof d.id === "string" && d.level !== "index")
    .map(({ el, d }) => ({
      id: String(d!.id),
      title: String(d!.title ?? el.name ?? d!.id),
      summary: typeof d!.summary === "string" ? d!.summary : "",
      level: typeof d!.level === "string" ? d!.level : null,
      covers: Array.isArray(d!.covers) ? (d!.covers as unknown[]).map(String) : [],
      x: el.x as number,
    }))
    .sort((a, b) => (order[a.level ?? ""] ?? 3) - (order[b.level ?? ""] ?? 3) || a.x - b.x)
    .map(({ x: _x, ...row }) => row);
}

/** The index frame's spec: one linked row per diagram, grouped by level. */
export function indexSpec(
  scene: readonly Element[],
  width: LineWidth,
  title = "Index",
  at?: { x: number; y: number },
): AddShapesSpec {
  const rows = diagramsIn(scene);
  const shapes: ShapeSpec[] = [];
  let y = 0;
  let level: string | null | undefined;
  const small = TEXT_SIZE.small;
  for (const row of rows) {
    if (row.level !== level) {
      level = row.level;
      if (shapes.length) y += 20;
      const heading = (level ?? "other").toUpperCase();
      shapes.push({
        id: `level-${level ?? "other"}`,
        type: "text",
        x: 0,
        y,
        text: heading,
        size: "small",
        color: "muted",
      });
      y += snapUp(measure(heading, small, width).height + 8);
    }
    const link = `${row.title}  →`;
    shapes.push({
      id: `go-${row.id}`,
      type: "text",
      x: 0,
      y,
      text: link,
      size: "heading",
      color: "blue",
      link: `kaava://diagram/${row.id}`,
    });
    y += snapUp(measure(link, TEXT_SIZE.heading, width).height + 4);
    const detail = [row.summary, row.covers.length ? `covers: ${row.covers.join(", ")}` : ""]
      .filter(Boolean)
      .join("\n");
    if (detail) {
      shapes.push({
        id: `about-${row.id}`,
        type: "text",
        x: 0,
        y,
        text: detail,
        size: "small",
        color: "muted",
        maxWidth: 520,
      });
      y += snapUp(measure(wrap(detail, small, 520, width), small, width).height);
    }
    y += 20;
  }
  if (!rows.length)
    shapes.push({
      id: "empty",
      type: "text",
      x: 0,
      y: 0,
      text: "No named diagrams yet.",
      color: "muted",
    });
  return {
    frame: {
      id: "index",
      title,
      summary: "What each diagram covers. Each title links to its diagram.",
      level: "index",
      ...(at ?? {}),
    },
    shapes,
  };
}
