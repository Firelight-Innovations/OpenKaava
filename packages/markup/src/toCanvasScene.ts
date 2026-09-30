/**
 * The Canvas bridge, read side. Turns a markup JSON into an Excalidraw scene a
 * Canvas file can hold: the captured frame as a locked image element, and the
 * ink on top of it at the same offsets it had over the host.
 *
 * Nothing here touches the Canvas app. "Open in Canvas" is a later change that
 * calls this, writes the frame's bytes into `files[fileId]`, and saves the
 * result; the function stays pure so that step has nothing to mock.
 */
import { live } from "./elements";
import type { MarkupJson } from "./format";
import type { MarkupElement } from "./types";

export interface ToCanvasSceneOptions {
  /** Where the frame's top-left corner goes on the canvas. Ink is offset by the same amount. */
  origin?: { x: number; y: number };
}

/** Shaped like `SceneFile` in `apps/canvas`: an Excalidraw scene with no files yet. */
export interface CanvasScene {
  type: "excalidraw";
  version: 2;
  source: string;
  elements: MarkupElement[];
  appState: Record<string, unknown>;
  /** Empty: the caller adds `files[imageFileId]` with the frame's data URL. */
  files: Record<string, unknown>;
}

export const FRAME_ELEMENT_ID = "kaava-markup-frame";

/**
 * @param imageFileId The id the caller will register the frame's bytes under.
 */
export function toCanvasScene(
  markup: MarkupJson,
  imageFileId: string,
  opts: ToCanvasSceneOptions = {},
): CanvasScene {
  const ox = opts.origin?.x ?? 0;
  const oy = opts.origin?.y ?? 0;

  const frame: MarkupElement = {
    id: FRAME_ELEMENT_ID,
    type: "image",
    x: ox,
    y: oy,
    width: markup.size.width,
    height: markup.size.height,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: true,
    status: "saved",
    fileId: imageFileId,
    scale: [1, 1],
    crop: null,
  };

  const ink = live(markup.excalidraw.elements).map((el) => ({
    ...el,
    x: el.x + ox,
    y: el.y + oy,
    locked: false,
  }));

  return {
    type: "excalidraw",
    version: 2,
    source: "kaava-markup",
    elements: [frame, ...ink],
    appState: {},
    files: {},
  };
}
