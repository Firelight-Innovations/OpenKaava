/**
 * The PNG half of `exportMarkup`: the host's background frame with the ink
 * composited on top at `devicePixelRatio`. This is the one module besides the
 * layer that imports Excalidraw.
 */
import { convertToExcalidrawElements, exportToBlob, getCommonBounds } from "@excalidraw/excalidraw";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import { frameBounds, inkOrigin, pngLayout } from "./composite";
import type { MarkupElement, MarkupHost } from "./types";

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png");
  });
}

/**
 * @param elements Live elements only; the caller has already dropped deleted ones.
 */
export async function renderMarkupPng(input: {
  host: Pick<MarkupHost, "capture" | "size">;
  elements: readonly MarkupElement[];
  files: BinaryFiles;
  dpr: number;
}): Promise<Blob> {
  const view = input.host.size();
  const layout = pngLayout(view, input.dpr);
  const bg = await createImageBitmap(await input.host.capture());

  const out = document.createElement("canvas");
  out.width = layout.width;
  out.height = layout.height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.drawImage(bg, 0, 0, layout.width, layout.height);
  bg.close();

  if (input.elements.length > 0) {
    // A transparent rectangle over the whole viewport: Excalidraw crops an
    // export to the bounds of its elements, and this makes those bounds at
    // least the viewport so the ink bitmap has a known origin.
    const f = frameBounds(view);
    const frame = convertToExcalidrawElements([
      {
        type: "rectangle",
        ...f,
        strokeColor: "transparent",
        backgroundColor: "transparent",
      },
    ]);
    const all = [...frame, ...(input.elements as never[])];
    const [minX, minY, maxX, maxY] = getCommonBounds(all);
    const ink = await exportToBlob({
      elements: all,
      files: input.files,
      exportPadding: 0,
      mimeType: "image/png",
      appState: { exportBackground: false, exportScale: layout.scale },
    });
    const bitmap = await createImageBitmap(ink);
    const at = inkOrigin(minX, minY, layout.scale);
    ctx.drawImage(
      bitmap,
      at.x,
      at.y,
      Math.round((maxX - minX) * layout.scale),
      Math.round((maxY - minY) * layout.scale),
    );
    bitmap.close();
  }
  return canvasBlob(out);
}
