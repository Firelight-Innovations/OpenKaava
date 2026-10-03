/**
 * Draws each sub-canvas frame's picture (see `subcanvas.ts`) and keeps it
 * current. Loaded with the editor, since it needs Excalidraw's exporter.
 *
 * Where a picture comes from, cheapest first: this session's memory (moving
 * back and forth between a parent and its children costs nothing), the disk
 * cache under `.kaava/canvas-snapshots/` (a canvas opens with every picture
 * at once), and last a fresh render of the child file, which is then cached.
 * Renders run one at a time, in idle time once input has paused, so a
 * parent with thirty stale pictures still pans while they fill in.
 *
 * Every picture is rendered in the light theme. The dark one is derived from
 * it with one canvas filter (`UNDO_IMAGE_INVERT`) rather than a second render.
 */
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { BinaryFileData, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { listSnapshots, putSnapshot, readCanvas, type SnapshotRow } from "./rpc";
import type { SceneElement } from "./scene";
import {
  placeSnapshots,
  subcanvasFrames,
  syncFrames,
  UNDO_IMAGE_INVERT,
  type ChildFrame,
  type Placed,
} from "./subcanvas";

/** The widest or tallest a picture is drawn, in pixels. Sharp at the zooms an
 *  overview is read at; past that, double-click into the child. */
const MAX_PX = 1600;

/** How often an open parent checks its children for edits. */
const POLL_MS = 2000;

interface Drawn {
  mtime: number;
  /** A data URL of the light-theme PNG. */
  light: string;
  dark?: string;
}

/** How long input must have stopped before a render may start. One render
 *  holds the main thread for tens of milliseconds and cannot be split, so it
 *  waits for a pause rather than landing in the middle of a pan. */
const QUIET_MS = 700;

let lastInput = 0;
const busy = (e: Event) => {
  // A bare hover is not a pan; a drag is.
  if (e.type === "pointermove" && (e as PointerEvent).buttons === 0) return;
  lastInput = performance.now();
};
for (const type of ["wheel", "pointermove", "pointerdown", "keydown", "touchmove"]) {
  window.addEventListener(type, busy, { capture: true, passive: true });
}

/** Resolves once input has been quiet for `QUIET_MS`. */
async function quiet() {
  for (;;) {
    const left = lastInput + QUIET_MS - performance.now();
    if (left <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, left));
  }
}

/** Pictures drawn or loaded this session, by child canvas id. */
const drawn = new Map<string, Drawn>();
/** Each child's own frame, as last read, by child canvas id. */
const childFrames = new Map<string, ChildFrame>();

const idle = () =>
  new Promise<void>((resolve) => {
    const ric = (
      window as unknown as {
        requestIdleCallback?: (cb: () => void, o: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 1000 });
    else setTimeout(resolve, 50);
  });

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("the picture did not decode"));
    img.src = src;
  });
}

/** The dark-theme picture: the light one through the inverse of Excalidraw's
 *  image filter, so the canvas's own dark filter inverts it like a drawing. */
async function darken(light: string): Promise<string> {
  const img = await loadImage(light);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return light;
  ctx.filter = UNDO_IMAGE_INVERT;
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL("image/png");
}

export class SnapshotPainter {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private applying: Promise<void> = Promise.resolve();

  constructor(
    private readonly api: ExcalidrawImperativeAPI,
    private readonly canvasId: string,
    private readonly theme: () => "light" | "dark",
    private readonly readOnly: boolean,
  ) {}

  start() {
    void this.tick();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** The theme changed: swap every picture for the other theme's. */
  repaint() {
    this.queueApply();
  }

  private elements() {
    return this.api.getSceneElements() as unknown as SceneElement[];
  }

  private async tick() {
    if (this.stopped) return;
    try {
      await this.refresh();
    } catch (err) {
      console.warn("[canvas] sub-canvas pictures:", err);
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), POLL_MS);
  }

  private async refresh() {
    if (document.visibilityState !== "visible") return;
    if (subcanvasFrames(this.elements()).length === 0) return;
    const known: Record<string, number> = {};
    for (const [child, d] of drawn) known[child] = d.mtime;
    const { frames } = await listSnapshots(this.canvasId, known);
    const stale: SnapshotRow[] = [];
    for (const row of frames) {
      if (row.childFrame) {
        childFrames.set(row.child, {
          width: row.childFrame.width,
          height: row.childFrame.height,
          name: row.childFrame.name,
        });
      }
      if (row.missing || row.mtime === null || row.unchanged) continue;
      if (row.png)
        drawn.set(row.child, { mtime: row.mtime, light: `data:image/png;base64,${row.png}` });
      else stale.push(row);
    }
    await this.queueApply();
    for (const row of stale) {
      if (this.stopped) return;
      await quiet();
      await idle();
      if (this.stopped) return;
      await this.draw(row);
      await this.queueApply();
    }
  }

  /** Render `row`'s child from its file, keep it, and cache it on disk. */
  private async draw(row: SnapshotRow) {
    const doc = await readCanvas(row.child);
    if (doc.mtime === null) return;
    const frameId = row.childFrame?.id ?? row.frame;
    const { render } = await import("./agentOps");
    const out = await render({
      scene: doc.scene as never,
      frameId,
      scale: 1,
      maxDimension: MAX_PX,
      background: false,
    });
    drawn.set(row.child, { mtime: doc.mtime, light: out.png });
    void putSnapshot(row.child, doc.mtime, out.png, out.width, out.height).catch(() => {
      // Only the cache is lost: the next open draws it again.
    });
  }

  /** Apply calls run one after another, so two never race on the scene. */
  private queueApply(): Promise<void> {
    this.applying = this.applying.then(() => this.apply()).catch(() => undefined);
    return this.applying;
  }

  /** Put the pictures there are into the scene, and size each frame to its child's. */
  private async apply() {
    if (this.stopped) return;
    const theme = this.theme();
    const pictures = new Map<string, Placed>();
    const files: BinaryFileData[] = [];
    const have = this.api.getFiles();
    for (const { frame, child } of subcanvasFrames(this.elements())) {
      const d = drawn.get(child);
      if (!d) continue;
      const fileId = `kaava-snapshot:${child}:${d.mtime}:${theme}`;
      if (!have[fileId]) {
        const dataURL = theme === "dark" ? (d.dark ??= await darken(d.light)) : d.light;
        files.push({
          id: fileId,
          dataURL,
          mimeType: "image/png",
          created: Date.now(),
        } as unknown as BinaryFileData);
      }
      pictures.set(frame.id, { fileId });
    }
    if (this.stopped) return;
    if (files.length) this.api.addFiles(files);
    // Read again: the awaits above let the person edit meanwhile.
    const now = this.elements();
    const synced = this.readOnly ? null : syncFrames(now, childFrames);
    const base = synced ?? now;
    const placed = placeSnapshots(base, pictures);
    if (!placed && !synced) return;
    this.api.updateScene({
      elements: (placed ?? base) as never,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }
}
