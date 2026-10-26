/**
 * The lower-right region of the search overlay: a read-only look at whichever
 * file the results list or the locator tree currently has focused.
 *
 * The user can never edit, save, or type into this pane — `readOnly` and
 * `domReadOnly` are hard-coded `true` in `./previewMonaco.ts` and nothing here
 * flips either. That is why this component owns no dirty state, no save handler
 * and no conflict banner; `apps/files/ui/src/viewer/TextViewer.tsx` has those
 * because that pane is written to. This one only ever reads.
 *
 * Everything Monaco-shaped is in `./previewMonaco.ts`, mirroring the split
 * `TextViewer.tsx`/`monaco.ts` draw in `apps/files/`: this file is a React
 * component and a state machine, holding only that module's opaque types.
 *
 * Meant to be reached the way `DiffView` is — a `lazy(() => import(…))` one
 * level up — so Monaco and its worker chunk are not paid for until the search
 * overlay actually mounts a preview. This module pulls Monaco in on evaluation
 * (via `./previewMonaco`), so the `lazy` boundary belongs at this file, not
 * inside it.
 */
import { useEffect, useRef, useState } from "react";
import type { LocatorFocus } from "./types";
import { callApp } from "../state/apps";
import {
  createEmptyPreviewModel,
  createPreviewModel,
  mountPreviewEditor,
  revealMatch,
  revealTop,
  type PreviewDecorations,
  type PreviewEditor,
  type PreviewModel,
} from "./previewMonaco";
import "./preview.css";

export interface PreviewPaneProps {
  /** What to show. `null` when nothing in the results list or locator tree is
   *  focused — the pane's own empty state, not a loading or error state. */
  focus: LocatorFocus | null;
  /** Forwarded verbatim to `callApp`'s scope, matching the convention
   *  `searchSource.ts`'s `scopeFor` already uses in this directory: `null`
   *  means no cluster rather than an absent one. */
  clusterId: string | null;
}

/** Mirrors the shape `callApp("files", "files/read", ...)` resolves with. */
interface FileText {
  text: string;
  truncated: boolean;
  limit: number;
  mtime: number | null;
}

/**
 * What the pane is doing, independent of whether Monaco has caught up yet.
 * `path` rides along on `"ready"` rather than being read back off `focus`, so
 * the model-swap effect below can tell "the file I already loaded" from "a new
 * focus arrived and a fresh read is in flight" without a second ref.
 */
type PreviewState =
  | { kind: "empty" }
  | { kind: "loading" }
  | { kind: "not-text" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      path: string;
      text: string;
      extension: string;
      truncated: boolean;
      limit: number;
    };

export default function PreviewPane({ focus, clusterId }: PreviewPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<PreviewEditor | null>(null);
  const modelRef = useRef<PreviewModel | null>(null);
  const decorationsRef = useRef<PreviewDecorations | null>(null);
  /** The path the mounted model currently shows text for, or `null` before the
   *  first file. Distinct from `focus?.path`: while a new focus is loading,
   *  this still names the *old* file, which is deliberately what stays on
   *  screen (dimmed by the loading banner) rather than flashing to blank. */
  const shownPathRef = useRef<string | null>(null);

  const [state, setState] = useState<PreviewState>({ kind: "empty" });

  /**
   * Mount the editor once, over an empty placeholder model, and take both down
   * on unmount.
   *
   * Deliberately an empty-dependency effect: this pane's whole point is to
   * reuse one editor instance across every file the user focuses, swapping
   * only the model (the second effect below). Depending on `focus` here would
   * tear down and rebuild the editor — losing scroll position and repainting
   * — on every row hovered in the results list.
   *
   * Disposal order matches DiffView's documented requirement: detach the model
   * (`setModel(null)`) before disposing it, then dispose the editor. Reversed,
   * Monaco throws "TextModel got disposed before DiffEditorWidget model got
   * reset" out of an event handler — DiffView's header has the full story.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const editor = mountPreviewEditor(host, createEmptyPreviewModel());
    editorRef.current = editor;
    modelRef.current = editor.getModel();

    return () => {
      editor.setModel(null);
      modelRef.current?.dispose();
      modelRef.current = null;
      decorationsRef.current = null;
      shownPathRef.current = null;
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  /**
   * Read the focused file whenever it changes.
   *
   * Keyed on `focus?.path` alone, not the whole `focus` object — a new
   * `LocatorFocus` with the same path but a different `match` (two hits inside
   * one file) must not re-read text it already has; the model-swap effect
   * below handles that case by re-revealing without touching `state`.
   */
  useEffect(() => {
    if (!focus) {
      setState({ kind: "empty" });
      return;
    }

    let cancelled = false;
    setState({ kind: "loading" });

    void callApp("files", "files/read", { path: focus.path }, scopeFor(clusterId))
      .then((result) => {
        if (cancelled) return;
        const file = result as FileText;
        setState({
          kind: "ready",
          path: focus.path,
          text: file.text,
          extension: extensionOf(focus.path),
          truncated: file.truncated,
          limit: file.limit,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Not an error: this file simply is not text, and the only way to
        // know that is to have tried. Shown as its own quiet state rather
        // than the failed-read banner.
        if (isNotUtf8Text(err)) {
          setState({ kind: "not-text" });
          return;
        }
        setState({ kind: "failed", message: describeReadError(err) });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above: `focus.match` must not retrigger a read.
  }, [focus?.path, clusterId]);

  /**
   * Swap the mounted editor's model in when a new file's text has arrived, and
   * reveal/highlight the current match on every pass — including a
   * match-only change that left `state` untouched.
   */
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || state.kind !== "ready") return;

    if (shownPathRef.current !== state.path) {
      const model = createPreviewModel(state.text, state.path, state.extension);
      editor.setModel(model);
      // `setModel` above has already detached the outgoing model — disposing
      // it now is disposing something no longer attached, the same ordering
      // DiffView's teardown relies on.
      modelRef.current?.dispose();
      modelRef.current = model;
      shownPathRef.current = state.path;
    }

    const match = focus?.match ?? null;
    decorationsRef.current?.clear();
    decorationsRef.current = match ? revealMatch(editor, match) : null;
    if (!match) revealTop(editor);
  }, [state, focus?.match]);

  return (
    <div className="preview-pane">
      {state.kind === "empty" && (
        <p className="preview-pane__message">Select a result to preview it.</p>
      )}
      {state.kind === "loading" && <p className="preview-pane__message">Loading…</p>}
      {state.kind === "not-text" && (
        <p className="preview-pane__message">No preview — this file is not text.</p>
      )}
      {state.kind === "failed" && (
        <p className="preview-pane__message preview-pane__message--error">{state.message}</p>
      )}
      {state.kind === "ready" && state.truncated && (
        <p className="preview-pane__banner">
          Showing the first {formatSize(state.limit)} of this file.
        </p>
      )}

      {/* Always rendered, so `hostRef` is set before the mount effect runs, and
          so the editor stays alive across every state above — hidden behind
          them via CSS (`preview.css`) rather than unmounted, which is what
          lets it be reused instead of rebuilt. */}
      <div
        className={`preview-pane__editor${state.kind === "ready" ? "" : " preview-pane__editor--hidden"}`}
        ref={hostRef}
      />
    </div>
  );
}

/** `callApp` takes no scope at all rather than one with a `null` cluster —
 *  the same convention `searchSource.ts`'s `scopeFor` uses in this directory,
 *  restated rather than imported since that helper isn't exported. */
function scopeFor(clusterId: string | null) {
  return clusterId === null ? undefined : { clusterId };
}

/**
 * The extension, lowercased, without the dot — ported from `extensionOf` in
 * `apps/files/ui/src/rpc.ts`. Duplicated rather than imported for the same
 * reason as everything else in this pane borrows rather than reaches: `src/`
 * may not import `apps/files/`.
 */
function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const sep = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (dot <= sep + 1 || dot === -1) return "";
  return path.slice(dot + 1).toLowerCase();
}

/**
 * Bytes as a person reads them — ported from `formatSize` in
 * `apps/files/ui/src/rpc.ts`, verbatim, for the truncation banner.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A plain `{ code, message, data? }` rejection — what `callApp` throws. Not a
 *  `VeistraRpcError`: that class belongs to `@veistra/bridge`'s `invoke`, used by
 *  an app's own iframe-side RPC channel. `callApp` forwards Tauri's raw
 *  `app_call` rejection straight through instead (see `ToolWindow.tsx`'s note
 *  by its own `callApp` call), which arrives as plain deserialized JSON. */
interface RpcErrorLike {
  code?: unknown;
  message?: unknown;
}

/**
 * Whether a `files/read` failed because the file is not UTF-8 text — ported
 * from `isNotText` in `apps/files/ui/src/rpc.ts`, matched on message for the
 * same reason that file gives: the backend answers `INVALID_PARAMS` for this
 * as it does for several other refusals, and a dedicated error code would be a
 * protocol change for one caller on one side of the app boundary.
 */
function isNotUtf8Text(err: unknown): boolean {
  const e = err as RpcErrorLike | null;
  return typeof e?.message === "string" && e.message.includes("is not a UTF-8 text file");
}

/** The failing method's message, with its code if one came through. */
function describeReadError(err: unknown): string {
  const e = err as RpcErrorLike | null;
  if (e && typeof e.message === "string") {
    return typeof e.code !== "undefined" ? `[${String(e.code)}] ${e.message}` : e.message;
  }
  return String(err);
}
