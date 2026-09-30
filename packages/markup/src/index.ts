/**
 * `@kaava/markup`, the pure half: types, host adapters, the session model, the
 * JSON format and the Canvas bridge. Nothing here imports Excalidraw or React,
 * so it is cheap to import from anywhere. The layer component is in
 * `@kaava/markup/layer`.
 */
export * from "./types";
export { imageHost } from "./imageHost";
export type { ImageHost, ImageHostOptions } from "./imageHost";
export { sceneHost } from "./sceneHost";
export type { SceneHostInfo } from "./sceneHost";
export { buildMarkupJson, isMarkupJson, MARKUP_VERSION } from "./format";
export type { BuildInput, MarkupAnnotationJson, MarkupJson, MarkupPinJson } from "./format";
export { toCanvasScene, FRAME_ELEMENT_ID } from "./toCanvasScene";
export type { CanvasScene, ToCanvasSceneOptions } from "./toCanvasScene";
export { MarkupSessions, composeScene, followPins, hasInk, inView, poseMatches } from "./session";
export type { ComposedScene, MarkupSession } from "./session";
export {
  PIN_SIZE,
  listPins,
  movePinTo,
  nextPinNumber,
  pinGroupId,
  pinSkeleton,
  setPinNote,
} from "./pins";
export type { PinColors, PinInput, PinRecord, PinSkeleton } from "./pins";
export { annotateTargets, resolveTargets, targetPoint } from "./targets";
export { MAX_PNG_SIDE, frameBounds, inkOrigin, pngLayout } from "./composite";
export { buildPalette, readPalette, toHex } from "./palette";
export type { InkPalette, InkSwatch } from "./palette";
