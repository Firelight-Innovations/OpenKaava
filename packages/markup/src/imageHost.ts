/**
 * A host for a plain image: a Godot "Render view" PNG, a Blender render, a
 * screenshot. There is nothing to pick and no camera, so markup over it is ink
 * and pins with no world points.
 */
import type { MarkupHost, ViewSize } from "./types";

export interface ImageHostOptions {
  /** What `describe()` reports as `path`. Defaults to `src`, which is fine for a file path, wrong for a data URL. */
  path?: string;
  /**
   * The size the image is displayed at, in CSS pixels. Markup coordinates are
   * relative to this box, so give it when the image is scaled to fit; left out,
   * the image's natural size is used.
   */
  size?: ViewSize;
  /** Test seams. */
  fetchImpl?: (src: string) => Promise<{ ok: boolean; status: number; blob(): Promise<Blob> }>;
  loadImage?: (src: string) => Promise<ViewSize>;
}

export interface ImageHost extends MarkupHost {
  /** Resolves once the natural size is known. `size()` is 0x0 until then unless `size` was given. */
  ready: Promise<void>;
  /** The displayed size changed (the pane was resized). */
  setSize(size: ViewSize): void;
}

function browserLoadImage(src: string): Promise<ViewSize> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error(`could not load image: ${src}`));
    img.src = src;
  });
}

export function imageHost(src: string, opts: ImageHostOptions = {}): ImageHost {
  const doFetch = opts.fetchImpl ?? ((s: string) => fetch(s));
  const load = opts.loadImage ?? browserLoadImage;
  let natural: ViewSize = { width: 0, height: 0 };
  let display: ViewSize | null = opts.size ?? null;
  let blob: Promise<Blob> | null = null;

  const ready = opts.size
    ? Promise.resolve()
    : load(src).then((s) => {
        natural = s;
      });

  return {
    ready,
    setSize(size) {
      display = size;
    },
    size() {
      return display ?? natural;
    },
    capture() {
      blob ??= doFetch(src).then((res) => {
        if (!res.ok) throw new Error(`could not read image (${res.status}): ${src}`);
        return res.blob();
      });
      // A failed read must not be cached, or a retry would fail forever.
      blob.catch(() => {
        blob = null;
      });
      return blob;
    },
    describe() {
      return { kind: "image", path: opts.path ?? src };
    },
  };
}
