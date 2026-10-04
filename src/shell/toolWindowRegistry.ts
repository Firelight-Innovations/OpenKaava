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
  /** Pass an OS file drag to the Files frame under the point; false if none took it. */
  routeOsFileDrag(drag: OsFileDragMessage): boolean;
}

/** An OS drag as a Files frame sees it (frame coordinates). */
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
