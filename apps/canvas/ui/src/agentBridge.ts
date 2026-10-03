/**
 * The door Rust knocks on: `window.__kaavaCanvas`.
 *
 * `src-tauri/src/apps/canvas/webview.rs` evaluates a script in the shell
 * window that looks for this object in every app iframe and calls `run`. The
 * heavy operations are imported on first use, so a canvas pane that no agent
 * talks to never loads them.
 *
 * `window.__kaavaContext` is the same idea for the agent server's `context`
 * tool: what this app is showing and what is selected, asked for rather than
 * scraped from the DOM.
 *
 * Rejected: a bridge message from Rust to the app (`@openkaava/bridge`). The
 * bridge carries requests from an app to Rust, not the other way, and adding
 * a reverse channel for one app would be a protocol change for all of them.
 */

export interface EditorHooks {
  /** The canvas id the editor has open, or null. */
  currentId: () => string | null;
  /** Write any pending edit now. */
  flush: () => Promise<{ saved: boolean; mtime: number | null }>;
  /** What the person has selected, for the `context` tool. */
  selection: () => { elementIds: string[]; diagram: string | null };
}

let hooks: EditorHooks | null = null;

/** Called by `App` once it can answer; `null` when it unmounts. */
export function setEditorHooks(next: EditorHooks | null): void {
  hooks = next;
}

export async function run(op: string, payload: unknown): Promise<unknown> {
  switch (op) {
    case "render": {
      const ops = await import("./agentOps");
      return ops.render(payload as Parameters<typeof ops.render>[0]);
    }
    case "addShapes": {
      const ops = await import("./agentOps");
      return ops.addShapesOp(payload as Parameters<typeof ops.addShapesOp>[0]);
    }
    case "mermaid": {
      const ops = await import("./agentOps");
      return ops.mermaidOp(payload as Parameters<typeof ops.mermaidOp>[0]);
    }
    case "flush": {
      if (!hooks) throw new Error("the canvas editor is not ready");
      return hooks.flush();
    }
    default:
      throw new Error(`unknown canvas operation \`${op}\``);
  }
}

declare global {
  interface Window {
    __kaavaCanvas?: { currentId: () => string | null; run: typeof run };
    __kaavaContext?: () => Record<string, unknown>;
  }
}

/** Install both hooks on this window. Idempotent. */
export function install(): void {
  window.__kaavaCanvas = { currentId: () => hooks?.currentId() ?? null, run };
  window.__kaavaContext = () => ({
    app: "canvas",
    canvas: hooks?.currentId() ?? null,
    ...(hooks?.selection() ?? { elementIds: [], diagram: null }),
  });
}
