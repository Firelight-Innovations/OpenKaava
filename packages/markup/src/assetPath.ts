/**
 * Tells Excalidraw where its fonts are, exactly as `apps/canvas/ui/src/assetPath.ts`
 * does: `vite.config.ts`'s `excalidrawFonts` plugin serves and emits them at
 * `/vendor/excalidraw/fonts/`, so an app that adds this package needs no font
 * setup of its own. Must be evaluated before the library, which is why
 * `MarkupLayer.tsx` imports it first. Without it Excalidraw fetches from a
 * public CDN, which fails offline.
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

window.EXCALIDRAW_ASSET_PATH ??= "/vendor/excalidraw/";

export {};
