import type { Bounds } from "./rpc";

/** Where this app's own iframe sits in the main window, as the shell reports
 * it over `kaava/window-rect` (`src/shell/toolwindow/ToolWindow.tsx`). Logical
 * pixels, matching `getBoundingClientRect()` — no DPI conversion either side. */
export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Narrows an `on()` payload (`unknown`) to a `FrameRect` before it is trusted
 * as geometry. */
export function isFrameRect(payload: unknown): payload is FrameRect {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.x === "number" &&
    typeof p.y === "number" &&
    typeof p.width === "number" &&
    typeof p.height === "number"
  );
}

/**
 * Combine the shell's window-space report of this app's iframe (`frame`) with
 * a rect measured *inside* that iframe (`paneRef.current.getBoundingClientRect()`,
 * `local`), to get the absolute bounds Rust's `add_child`/`set_position` need.
 *
 * `local` alone is not enough: `getBoundingClientRect()` inside an iframe is
 * relative to that iframe's own viewport, not the main window, so sending it
 * straight through lands the webview at the window's top-left every time.
 * `frame` is the correction — the iframe's own position within the window,
 * which nothing in this document can see for itself.
 */
export function absoluteBounds(
  frame: FrameRect,
  local: { x: number; y: number; width: number; height: number },
): Bounds {
  return {
    x: frame.x + local.x,
    y: frame.y + local.y,
    width: local.width,
    height: local.height,
  };
}
