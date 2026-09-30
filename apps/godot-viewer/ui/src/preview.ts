/**
 * Getting a scene's 3D preview from the backend: ask for the export, wait for
 * it, fetch the glb. Kept free of React so the waiting can be tested with a
 * fake clock and a fake backend.
 *
 * The backend exports only when the scene (or something it instances) changed,
 * so asking again is cheap: an unchanged scene answers `ready` at once.
 */
import type { PreviewAnswer } from "./rpc";

export interface LoadedPreview {
  glb: ArrayBuffer;
  /** Path the 3D view reports for a node, to the scene path of that node. */
  nodeMap: Record<string, string>;
  /** Absolute path of the glb on disk. */
  path: string;
  exportedAt: number;
  godot: string | null;
}

/** The export ran and failed. `output` is the tail of what Godot printed. */
export class PreviewFailure extends Error {
  readonly output: string[];
  constructor(message: string, output: string[] = []) {
    super(message);
    this.name = "PreviewFailure";
    this.output = output;
  }
}

export interface PreviewIo {
  request(force: boolean): Promise<PreviewAnswer>;
  bytes(): Promise<{ base64: string }>;
  sleep(ms: number): Promise<void>;
}

export interface LoadOptions {
  force?: boolean;
  signal: AbortSignal;
  /** What the export is doing, while it is running. */
  onPhase?: (phase: string) => void;
  pollMs?: number;
  /** Give up waiting after this long. The backend has its own limits; this is the last resort. */
  maxWaitMs?: number;
}

export const POLL_MS = 600;
const MAX_WAIT_MS = 10 * 60 * 1000;

export function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function cancelled(): Error {
  return new DOMException("The preview request was cancelled", "AbortError");
}

export async function loadPreview(io: PreviewIo, opts: LoadOptions): Promise<LoadedPreview> {
  const { signal, onPhase, pollMs = POLL_MS, maxWaitMs = MAX_WAIT_MS } = opts;
  let force = opts.force ?? false;
  let waited = 0;
  for (;;) {
    if (signal.aborted) throw cancelled();
    const answer = await io.request(force);
    if (signal.aborted) throw cancelled();
    // Only the first ask forces; after that the job it started is what is polled.
    force = false;

    if (answer.status === "failed") {
      throw new PreviewFailure(answer.error ?? "The export failed.", answer.output);
    }
    if (answer.status === "ready") {
      if (!answer.path || !answer.nodeMap || answer.exportedAt === null) {
        throw new PreviewFailure("The backend said the preview was ready but did not describe it.");
      }
      const { base64 } = await io.bytes();
      if (signal.aborted) throw cancelled();
      return {
        glb: decodeBase64(base64),
        nodeMap: answer.nodeMap,
        path: answer.path,
        exportedAt: answer.exportedAt,
        godot: answer.godot,
      };
    }
    onPhase?.(answer.phase ?? "exporting");
    if (waited >= maxWaitMs) throw new PreviewFailure("The export did not finish in time.");
    await io.sleep(pollMs);
    waited += pollMs;
  }
}

/** Scene path to the path the 3D view uses, and back. Both fall back to the nearest node that has one. */
export interface NodeLookup {
  toScene(viewPath: string | null): string | null;
  toView(scenePath: string | null): string | null;
}

function ancestors(path: string): string[] {
  const out: string[] = [];
  let at = path;
  for (;;) {
    out.push(at);
    const cut = at.lastIndexOf("/");
    if (cut < 0) return out;
    at = at.slice(0, cut);
  }
}

/**
 * Some scene nodes have nothing to draw (a `CanvasLayer`, a script-only node)
 * and some drawn parts have no node of their own, so a lookup that misses walks
 * up to the closest ancestor that did map: clicking a part of the chair selects
 * the chair, and clicking a hud label in the tree highlights the nearest thing
 * that is drawn instead of nothing.
 */
export function nodeLookup(nodeMap: Record<string, string>): NodeLookup {
  const reverse = new Map<string, string>();
  for (const [view, scene] of Object.entries(nodeMap)) reverse.set(scene, view);
  return {
    toScene(viewPath) {
      if (viewPath === null) return null;
      for (const at of ancestors(viewPath)) {
        const scene = nodeMap[at];
        if (scene !== undefined) return scene;
      }
      return null;
    },
    toView(scenePath) {
      if (scenePath === null) return null;
      for (const at of ancestors(scenePath)) {
        const view = reverse.get(at);
        if (view !== undefined) return view;
      }
      return null;
    },
  };
}

/** The glb's location as an agent would open it: from `.kaava` down when it is inside one. */
export function projectRelative(absolute: string): string {
  const path = absolute.replace(/\\/g, "/");
  const at = path.indexOf("/.kaava/");
  return at >= 0 ? path.slice(at + 1) : path;
}
