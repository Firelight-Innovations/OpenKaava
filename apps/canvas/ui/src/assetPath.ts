/**
 * Tells Excalidraw where its fonts are. Must run before the library is
 * evaluated, so `Editor.tsx` imports this first (ES modules evaluate in import
 * order). `vite.config.ts`'s `excalidrawFonts` plugin serves that folder in
 * development and emits it into `dist/` in a build; without this Excalidraw
 * fetches its fonts from a public CDN, which fails offline.
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

window.EXCALIDRAW_ASSET_PATH = "/vendor/excalidraw/";

export {};
