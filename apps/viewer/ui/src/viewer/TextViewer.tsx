/**
 * A file, editable, in Monaco.
 *
 * This is also the registry's catch-all. `registry.ts` sends every file here
 * that no other viewer claimed, because whether bytes decode as UTF-8 is not
 * knowable from a name — so the read is the test, and a `not a UTF-8 text file`
 * rejection is handed on with `reopenWith("unsupported")`. Any other failure is
 * shown as itself.
 *
 * What this deliberately does not own:
 *
 * - **Monaco.** Every import of it is in `./monaco`, so this file is a React
 *   component and a state machine and nothing else.
 * - **The buffer.** See the effect that fetches it below.
 * - **Writing.** `saveDocument` is the one implementation; this file decides
 *   what to draw when it fails, not what to send.
 * - **Which viewer a file belongs to.** The one exception is the way *back*
 *   from a source toggle; see `rendered` below.
 */
import { useEffect, useRef, useState } from "react";
import { pick, type ViewerProps } from "./registry";
import { clearActiveEditor, setActiveEditor } from "./activeEditor";
import {
  bindPreview,
  bindSave,
  createGitGutter,
  createModel,
  loadEditorSettings,
  mountEditor,
  retargetModel,
  type EditorSettings,
} from "./monaco";
import { previewKindFor } from "../preview/previewKind";
import { previewControl } from "../preview/previewControl";
import { takeTopLine } from "../preview/previewSync";
import { gitHunks } from "./gitHunks";
import { gitHead } from "./gitHead";
import { documents, requestReload, saveDocument, type TabDocument } from "../tabs/useOpenFiles";
import { describe, formatSize, isNotText, readText, staleWrite } from "../rpc";
import "./text.css";

export default function TextViewer({ file, onDirty, registerSave, reopenWith }: ViewerProps) {
  const [doc, setDoc] = useState<TabDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when a write lost a race, carrying the mtime it lost to. */
  const [conflict, setConflict] = useState<{ mtime: number | null } | null>(null);
  /**
   * The `editor.*` settings, `null` until the first fetch lands.
   *
   * The mount effect below waits for them rather than building an editor it
   * would then have to rebuild — Monaco takes these at construction, and a
   * remount would throw away the caret and the undo stack the effect exists to
   * preserve. `loadEditorSettings` memoises a single bridge call, so the wait
   * is only ever on the first file this frame opens.
   */
  const [editorSettings, setEditorSettings] = useState<EditorSettings | null>(null);

  const hostRef = useRef<HTMLDivElement | null>(null);

  /**
   * The three callback props, held in a ref and refreshed on every render.
   *
   * `App.tsx` builds all three inline — `onDirty={(d) => files.setDirty(...)}`
   * — so their identity changes every render. An effect that listed them as
   * dependencies would tear down and rebuild the editor on each keystroke,
   * losing the caret every time. Assigned during render rather than in an
   * effect so that a `readText` promise resolving between commits still calls
   * the current one.
   */
  const latest = useRef({ onDirty, registerSave, reopenWith });
  latest.current = { onDirty, registerSave, reopenWith };

  // Never rejects — a settings read that fails resolves to this build's own
  // defaults, because an app has to open files whether or not its host can
  // answer. See `loadSettings` in `../settings`.
  useEffect(() => {
    let cancelled = false;
    void loadEditorSettings().then((next) => {
      if (!cancelled) setEditorSettings(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Get the buffer for this path: the one already open, or a fresh read.
   *
   * This component does not own the buffer. The model, its saved version, its
   * base mtime and its view state live in `documents` (`../tabs/useOpenFiles`),
   * keyed by path and outliving this component. That is the whole reason undo
   * history, cursor and scroll survive a tab switch: switching tabs unmounts
   * this, and if the model were a `useRef` here it would go with it.
   *
   * Keyed on the path alone. A reload is a *remount* — `App.tsx` puts the tab's
   * nonce in this component's key — and the store is emptied before the nonce
   * bumps, so arriving here with a cached document always means a tab switch,
   * never a stale reload.
   */
  useEffect(() => {
    const open = documents.get(file.path);
    if (open) {
      setDoc(open);
      return;
    }

    let cancelled = false;
    setDoc(null);
    setError(null);
    setConflict(null);

    void readText(file.path)
      .then((result) => {
        if (cancelled) return;
        const model = createModel(result.text, file.path, file.ext);
        const next: TabDocument = {
          model,
          savedVersionId: model.getAlternativeVersionId(),
          baseMtime: result.mtime,
          truncatedAt: result.truncated ? result.limit : null,
          viewState: null,
          ext: file.ext,
        };
        documents.put(file.path, next);
        setDoc(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // The one error that is not an error: this file is not text, and the
        // registry's fallback ordering meant we were always going to find that
        // out by trying. Hand it to the viewer that says so.
        if (isNotText(err)) {
          latest.current.reopenWith("unsupported");
          return;
        }
        setError(describe("files/read", err));
      });

    return () => {
      cancelled = true;
    };
  }, [file.path, file.ext]);

  /**
   * Mount an editor over the buffer, and take it down again on unmount.
   *
   * The model is not disposed here — `documents` owns it, and disposing it on a
   * tab switch is exactly the leak-in-reverse that would throw away undo
   * history. A standalone editor only disposes a model it created itself, and
   * this one was handed one, so `editor.dispose()` leaves it alone.
   *
   * Runs once `editorSettings` has arrived, and again if it ever changed — it
   * does not today, since it is set once and never re-fetched.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!doc || !host || !editorSettings) return;

    // A rename can change the extension under a buffer that was deliberately
    // *not* re-read, so the model may still be tokenizing the old file type.
    // Put right here rather than in `rekey`, because this is the Monaco side of
    // the app and that one may not import it — see this file's header.
    if (doc.ext !== file.ext) {
      retargetModel(doc.model, file.ext);
      doc.ext = file.ext;
    }

    const readOnly = doc.truncatedAt !== null;
    const editor = mountEditor(host, doc.model, readOnly, editorSettings);
    if (doc.viewState) editor.restoreViewState(doc.viewState);
    // Coming back from a preview: land on the block the reader was looking at.
    const previewLine = takeTopLine(file.path);
    if (previewLine !== undefined) editor.setScrollTop(editor.getTopForLineNumber(previewLine));
    editor.focus();

    // The Edit menu in the shell's title bar acts on this editor, and nothing
    // in the shell can reach it — a menu command arrives as a window message
    // and is handled in `App.tsx`, which has no route into this component's
    // tree. See `./activeEditor` for the whole of that seam.
    setActiveEditor(editor);

    // Set to true in this effect's cleanup, and checked before every
    // `gitHunks` result is applied — this is the same guard the buffer-read
    // effect above uses `cancelled` for, kept separate because it lives on a
    // different effect with a different lifetime.
    let cancelled = false;

    /**
     * The dirty-diff gutter.
     *
     * Hunks are fetched fresh on every mount — a tab switch back to this
     * file, a reload, and a first open are all a mount — and again after
     * every save in `save` below, since a write is the other moment the
     * hunks against HEAD can change.
     *
     * HEAD's text is fetched once, here, and reused for every peek opened
     * against this editor: a save changes the working copy, not HEAD, so
     * there is nothing a refetch after save would pick up, and re-reading it
     * on every hunk update would make a save costlier for no different
     * result. `headText` is a plain closure variable rather than something
     * `useState` holds, because nothing here needs a re-render when it
     * arrives — it only has to be in place by the time a peek is opened.
     *
     * Both disposed in this effect's cleanup, alongside the editor.
     */
    const gutter = createGitGutter(editor);
    let headText = "";
    void Promise.all([gitHunks(file.path), gitHead(file.path)])
      .then(([hunks, head]) => {
        headText = head.text;
        if (!cancelled) gutter.update(hunks, headText);
      })
      .catch(() => {
        // Best-effort: a gutter that fails to appear is a missing
        // decoration, not a reason to show an error over a file that
        // otherwise opened fine.
      });

    // Dirty is a version comparison, not a flag, so undoing back to the saved
    // text clears the dot instead of leaving it stuck on.
    const report = () =>
      latest.current.onDirty(doc.model.getAlternativeVersionId() !== doc.savedVersionId);
    report();
    const changes = doc.model.onDidChangeContent(report);

    /**
     * Resolves on a stale conflict rather than rejecting, because the banner
     * below *is* the report and it is in the pane the user is looking at —
     * rejecting as well would put the same news in `App.tsx`'s error line at
     * the same moment. Every other failure is re-thrown so it lands there.
     *
     * The close-a-dirty-tab prompt does not come through here; it calls
     * `saveDocument` directly, so a stale conflict still stops it closing.
     */
    const save = async () => {
      try {
        await saveDocument(file.path);
        setConflict(null);
        report();
        void gitHunks(file.path)
          .then((hunks) => {
            // `headText` is already in scope from the mount-time fetch above
            // — see that comment for why a save does not refetch it.
            if (!cancelled) gutter.update(hunks, headText);
          })
          .catch(() => {
            /* Same as the fetch on mount: a stale or missing gutter after a
               save is not worth surfacing over a write that succeeded. */
          });
      } catch (err: unknown) {
        const stale = staleWrite(err);
        if (!stale) throw err;
        setConflict(stale);
      }
    };

    latest.current.registerSave(save);
    bindSave(editor, () => void save());
    // Only for a file with a rendered form. A `.rs` keeps Ctrl+Shift+V as paste.
    if (previewKindFor(file.ext) !== null) {
      bindPreview(editor, {
        toggle: () => previewControl()?.toggle(),
        toggleSide: () => previewControl()?.toggleSide(),
      });
    }

    return () => {
      cancelled = true;
      // Before the editor goes, or the caret and scroll go with it.
      doc.viewState = editor.saveViewState();
      clearActiveEditor(editor);
      changes.dispose();
      latest.current.registerSave(null);
      // Before `editor.dispose()` — the gutter's own teardown still needs a
      // live editor to remove its view zones and decorations from.
      gutter.dispose();
      editor.setModel(null);
      editor.dispose();
    };
  }, [doc, editorSettings, file.path, file.ext]);

  if (error) {
    return <p className="app__error text__failed">{error}</p>;
  }

  const truncatedAt = doc?.truncatedAt ?? null;

  /**
   * The way back out of a source toggle.
   *
   * `SvgViewer` and `MermaidViewer` each offer "view source", which calls
   * `reopenWith("text")` and lands here — but the override lives in
   * `Viewer.tsx` and neither of them can draw the control that undoes it. So
   * this viewer draws it, and without knowing they exist: whenever the file's
   * extension would normally have resolved to some *other* viewer, that
   * descriptor is the one to offer, and its label is the button. A viewer added
   * later gets the return trip for nothing.
   *
   * `pick` and not an extension list, and not `VIEWERS.find` either — `pick`
   * stops at `text`, which matches everything, so it can never hand back
   * `unsupported`. A `.ts` file resolves to `text` and shows no control at all.
   *
   * Round-tripping loses no edits. `reopenWith` swaps the viewer inside the
   * same tab; the model stays in `documents`, keyed by path, and comes back
   * with its undo history and its dirty state intact.
   */
  const rendered = pick(file);

  return (
    <div className="text">
      {rendered.id !== "text" && (
        <p className="text__banner text__banner--source">
          <span className="text__banner-text">Showing the source of {file.name}.</span>
          <button
            type="button"
            className="text__banner-action"
            onClick={() => reopenWith(rendered.id)}
          >
            View as {rendered.label}
          </button>
        </p>
      )}

      {truncatedAt !== null && (
        <p className="text__banner text__banner--note">
          Showing the first {formatSize(truncatedAt)} of this file. It is read-only here — saving
          would delete everything past that point.
        </p>
      )}

      {conflict && (
        <div className="text__banner text__banner--conflict">
          <span className="text__banner-text">
            {file.name} changed on disk after you opened it. Saving now would overwrite whatever
            changed it.
          </span>
          <button
            type="button"
            className="text__banner-action"
            onClick={() => requestReload(file.path)}
          >
            Reload from disk
          </button>
          <button
            type="button"
            className="text__banner-action"
            onClick={() => {
              // Adopt the mtime the backend reported as the file's current one,
              // so the retry is a write against *that* version rather than the
              // one we lost to. Written straight onto the document because the
              // document is the mutable record of "what this text is based on".
              const current = documents.get(file.path);
              if (!current) return;
              current.baseMtime = conflict.mtime;
              void saveDocument(file.path)
                .then(() => setConflict(null))
                .catch((err: unknown) => setError(describe("files/write", err)));
            }}
          >
            Overwrite
          </button>
        </div>
      )}

      {/* Always rendered, so the ref is set before the mount effect runs. */}
      <div className="text__editor" ref={hostRef} />
    </div>
  );
}
