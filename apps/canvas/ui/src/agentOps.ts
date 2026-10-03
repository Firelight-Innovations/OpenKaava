/**
 * The operations Rust asks a canvas frontend to run for an agent: render a
 * frame, lay out `add_shapes`, convert Mermaid. Loaded on first use, because
 * it pulls in Excalidraw (and Mermaid only when asked).
 *
 * None of these touch the open editor or write a file. Each takes a scene and
 * returns pixels or elements; `src-tauri/src/apps/canvas/methods.rs` does the
 * writing, so an agent's edit goes through the same stale-checked save as a
 * person's.
 */
import {
  exportToCanvas,
  restoreElements,
  convertToExcalidrawElements,
} from "@excalidraw/excalidraw";
import "./assetPath";
import {
  currentRender,
  text as textElement,
  withRender,
  type Element,
  type RenderStyle,
} from "./draw";
import { addShapes, indexSpec, type AddShapesSpec, type FrameSpec, type LineWidth } from "./layout";

export interface RenderRequest {
  scene: { elements: Element[]; files?: Record<string, unknown> };
  frameId: string;
  /** Frame-relative box to crop to. */
  region?: { x: number; y: number; width: number; height: number } | null;
  scale?: number | null;
  maxDimension?: number;
  theme?: "light" | "dark";
  /** Fill the canvas background (default); `false` leaves it transparent. */
  background?: boolean;
}

const live = (els: readonly Element[]) => els.filter((e) => !e.isDeleted);

const fontsReady = new Map<number, Promise<void>>();

/**
 * Make sure a font is loaded before anything is measured in it (Nunito unless a
 * style says otherwise). Rendering a one-word scene through `exportToCanvas` is
 * what loads it: Excalidraw registers its font faces and waits for them there,
 * so measuring afterwards uses exactly the font the renderer draws with. Cached
 * per family, since each style brings its own.
 */
function loadFonts(render?: Partial<RenderStyle>): Promise<void> {
  const family = render?.fontFamily ?? 6;
  let ready = fontsReady.get(family);
  if (!ready) {
    ready = (async () => {
      const probe = withRender(render, () =>
        textElement({
          id: "font-probe",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          frameId: null,
          text: "Probe",
          fontSize: 16,
        }),
      );
      await exportToCanvas({
        elements: restoreElements([probe] as never, null) as never,
        files: null,
        appState: { exportBackground: false },
      });
      await document.fonts.ready;
    })();
    fontsReady.set(family, ready);
  }
  return ready;
}

let context: CanvasRenderingContext2D | null = null;

/** Width of one line in Nunito, measured the way Excalidraw measures it. */
export const lineWidth: LineWidth = (line, fontSize) => {
  context ??= document.createElement("canvas").getContext("2d");
  if (!context) return line.length * fontSize * 0.6;
  context.font = `${fontSize}px ${currentRender().fontName}, Nunito, Segoe UI Emoji`;
  return context.measureText(line).width;
};

export async function render(req: RenderRequest) {
  const elements = live(restoreElements(req.scene.elements as never, null) as unknown as Element[]);
  const frame = elements.find((e) => e.id === req.frameId);
  if (!frame) throw new Error(`no frame ${req.frameId} in the scene`);
  const members = elements.filter(
    (e) =>
      e.id === frame.id ||
      e.frameId === frame.id ||
      elements.some((c) => c.id === e.containerId && c.frameId === frame.id),
  );
  const fw = frame.width as number;
  const fh = frame.height as number;
  const region = req.region ?? null;
  const cropW = region ? Math.max(1, Math.min(region.width, fw)) : fw;
  const cropH = region ? Math.max(1, Math.min(region.height, fh)) : fh;
  const max = req.maxDimension ?? 2400;
  const asked = req.scale ?? (region ? 2 : 1);
  const scale = Math.max(0.1, Math.min(asked, max / Math.max(cropW, cropH)));
  const full = await exportToCanvas({
    elements: members as never,
    files: (req.scene.files ?? null) as never,
    exportingFrame: frame as never,
    exportPadding: 0,
    appState: {
      exportBackground: req.background !== false,
      viewBackgroundColor: "#ffffff",
      exportWithDarkMode: req.theme === "dark",
      exportScale: scale,
      frameRendering: { enabled: true, name: false, outline: false, clip: true },
    } as never,
    getDimensions: (w: number, h: number) => ({ width: w * scale, height: h * scale, scale }),
  });
  let out = full;
  if (region) {
    out = document.createElement("canvas");
    out.width = Math.round(cropW * scale);
    out.height = Math.round(cropH * scale);
    const ctx = out.getContext("2d");
    if (!ctx) throw new Error("no 2D context to crop with");
    ctx.drawImage(
      full,
      Math.round(region.x * scale),
      Math.round(region.y * scale),
      out.width,
      out.height,
      0,
      0,
      out.width,
      out.height,
    );
  }
  const png = out.toDataURL("image/png");
  return { png, width: out.width, height: out.height, scale };
}

interface AuthorRequest {
  scene: {
    elements: Element[];
    kaava?: { values?: Record<string, unknown> };
    files?: Record<string, { kaavaRef?: string }>;
  };
  spec: AddShapesSpec & {
    index?: boolean;
    title?: string;
    x?: number;
    y?: number;
    /** The drawing style in force, resolved by Rust from the canvas and Settings. */
    render?: Partial<RenderStyle>;
  };
}

/** Fill in whatever a newer Excalidraw expects, keeping our sizes. */
function normalise(elements: Element[]): Element[] {
  return restoreElements(elements as never, null, {
    refreshDimensions: false,
    repairBindings: true,
  }) as unknown as Element[];
}

export async function addShapesOp(req: AuthorRequest) {
  const render = req.spec.render;
  await loadFonts(render);
  const elements = req.scene.elements ?? [];
  // Measured and built inside the style, so text is measured in the face it is
  // drawn in and every element gets that style's stroke, fill and roughness.
  const { spec, result } = withRender(render, () => {
    const spec = req.spec.index
      ? indexSpec(
          elements,
          lineWidth,
          req.spec.title,
          req.spec.x !== undefined && req.spec.y !== undefined
            ? { x: req.spec.x, y: req.spec.y }
            : undefined,
        )
      : req.spec;
    const result = addShapes(
      elements,
      spec,
      lineWidth,
      req.scene.kaava?.values ?? {},
      req.scene.files ?? {},
    );
    return { spec, result };
  });
  return {
    elements: normalise(result.elements),
    ids: result.ids,
    frame: result.frame,
    warnings: result.warnings,
    values: spec.values ?? null,
  };
}

/**
 * Mermaid source into a new frame. The graph is converted with Excalidraw's
 * own converter (the one its "Mermaid to Excalidraw" dialog uses), then moved
 * under a measured title and summary like every other diagram.
 */
export async function mermaidOp(req: {
  scene: AuthorRequest["scene"];
  spec: { frame: FrameSpec; source: string };
}) {
  await loadFonts();
  const source = req.spec.source;
  if (typeof source !== "string" || !source.trim())
    throw new Error("source is required: Mermaid text");
  const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
  const parsed = await parseMermaidToExcalidraw(source, { themeVariables: { fontSize: "16px" } });
  const converted = convertToExcalidrawElements(parsed.elements as never, {
    regenerateIds: true,
  }) as unknown as Element[];
  const header = addShapes(
    req.scene.elements ?? [],
    { frame: req.spec.frame, shapes: [] },
    lineWidth,
  );
  const [ox, oy] = header.frame.origin;
  const minX = Math.min(...converted.map((e) => e.x as number));
  const minY = Math.min(...converted.map((e) => e.y as number));
  const frameId = header.frame.elementId;
  let right = header.frame.x + header.frame.width;
  let bottom = header.frame.y + header.frame.height;
  const moved = converted.map((e) => {
    const x = (e.x as number) - minX + ox;
    const y = (e.y as number) - minY + oy;
    right = Math.max(right, x + (e.width as number) + 40);
    bottom = Math.max(bottom, y + (e.height as number) + 40);
    return { ...e, x, y, frameId } as Element;
  });
  const frameEl = header.elements[header.elements.length - 1]!;
  frameEl.width = Math.ceil((right - header.frame.x) / 10) * 10;
  frameEl.height = Math.ceil((bottom - header.frame.y) / 10) * 10;
  const elements = [...header.elements.slice(0, -1), ...moved, frameEl];
  return {
    elements: normalise(elements),
    ids: Object.fromEntries(moved.map((e) => [e.id, e.id])),
    frame: { ...header.frame, width: frameEl.width, height: frameEl.height },
    warnings: [
      ...header.warnings,
      "Mermaid text uses its own measurements; view-diagram to check it, and switch labels to add_shapes where it matters",
    ],
    values: null,
  };
}
