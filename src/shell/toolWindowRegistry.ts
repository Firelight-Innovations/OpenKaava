/**
 * How something outside `ToolWindow`'s own component tree reaches into a mounted
 * app frame: the one `ToolWindow` a window mounts registers itself here under
 * that window's label, and a caller elsewhere looks it up the same way. Why a
 * registry, why it sits directly under `src/shell/`, and why it is deliberately
 * not on `ToolWindowHandle`: `docs/design-notes/shell-core.md`.
 */
export interface ToolWindowBridge {
  /** Deliver `event`/`payload` to `instanceId`'s frame once its hello/ready
   *  handshake completes, queuing if it has not: an instance id can be minted
   *  and handed here before the iframe behind it mounts. See `ToolWindow.tsx`. */
  sendEventWhenReady(instanceId: string, event: string, payload: unknown): void;
  /**
   * Hand an operating-system file drag to the File Explorer frame under the point, if one
   * is there. `x`/`y` are window coordinates; the frame is told them relative to itself,
   * since it cannot see the shell's. Returns whether a Files frame took it, so the caller
   * can fall back (a drop over a terminal is the terminal's, not this).
   *
   * Needed because the webview owns OS drops (Tauri's `dragDropEnabled`): the HTML5 drop
   * events never reach an iframe, so the shell has to pass the drop in by hand.
   */
  routeOsFileDrag(drag: OsFileDragMessage): boolean;
}

/** What a Files frame is told about an OS drag over it, in the frame's own coordinates. */
export type OsFileDragMessage =
  | { phase: "over"; x: number; y: number }
  | { phase: "leave" }
  | { phase: "drop"; x: number; y: number; paths: string[] };

const bridges = new Map<string, ToolWindowBridge>();

export function registerToolWindow(label: string, bridge: ToolWindowBridge): void {
  bridges.set(label, bridge);
}

export function unregisterToolWindow(label: string): void {
  bridges.delete(label);
}

/** The bridge for one window, or `undefined` before its `ToolWindow` has mounted
 *  — no frame to reach into, and no overlay to open a search hit from. */
export function toolWindowBridge(label: string): ToolWindowBridge | undefined {
  return bridges.get(label);
}
