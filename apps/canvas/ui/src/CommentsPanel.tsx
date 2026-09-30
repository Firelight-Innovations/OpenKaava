/**
 * Review comments for people: point at elements or drag a box, write a note,
 * and see what an agent did about it.
 *
 * The comments are files beside the canvas (`canvas/<id>.comments/`), written
 * by Rust; this panel only calls `canvas/*-comment` methods and re-reads the
 * list. An agent resolves the same comments through the same methods, so a
 * resolution note appears here on the next refresh.
 *
 * Rejected: Excalidraw's own comment-like tools (sticky text, the link box).
 * They live in the drawing, so a note would be one more element in the diff,
 * would move with the thing it is about, and could not be resolved.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, MessageSquarePlus, RotateCcw, Scan, SquareDashedMousePointer } from "lucide-react";
import {
  createComment,
  listComments,
  messageOf,
  reopenComment,
  resolveComment,
  type CanvasComment,
  type CommentRegion,
} from "./rpc";

/** What the next comment points at, once the person has chosen. */
export type CommentTarget =
  { frameId: string; elementIds: string[] } | { frameId: string; region: CommentRegion };

type Filter = "open" | "resolved" | "all";

interface Props {
  canvasId: string;
  readOnly: boolean;
  /** Bumped by the app to make the list read disk again. */
  refreshKey: number;
  /** The chosen target, from the selection or a dragged box. */
  target: CommentTarget | null;
  /** Why the last attempt to choose a target failed, if it did. */
  targetError: string | null;
  canUseSelection: boolean;
  onUseSelection: () => void;
  onPickArea: () => void;
  onClearTarget: () => void;
  /** Title of a frame, by the key a comment stores. */
  frameTitle: (key: string) => string;
  /** Write pending edits first, so the elements named exist on disk. */
  flush: () => Promise<void>;
  onShow: (comment: CanvasComment) => void;
  onCounts?: (open: number) => void;
}

function describe(c: { elementIds?: string[]; region?: CommentRegion | null }): string {
  if (c.region) return `area ${Math.round(c.region.width)} x ${Math.round(c.region.height)}`;
  const n = c.elementIds?.length ?? 0;
  return n === 1 ? "1 element" : `${n} elements`;
}

const when = (iso: string) => iso.replace("T", " ").slice(0, 16);

export default function CommentsPanel(props: Props) {
  const { canvasId, refreshKey, onCounts } = props;
  const [rows, setRows] = useState<CanvasComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("open");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const reload = useCallback(async () => {
    try {
      const list = await listComments(canvasId);
      setRows(list.comments);
      setError(
        list.unreadable.length
          ? `${list.unreadable.length} comment file(s) could not be read.`
          : null,
      );
      onCounts?.(list.open);
    } catch (err) {
      setRows([]);
      setError(messageOf(err));
    }
  }, [canvasId, onCounts]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const post = async () => {
    const target = props.target;
    if (!target || !text.trim()) return;
    setBusy(true);
    try {
      await props.flush();
      const body =
        "region" in target ? { region: target.region } : { elementIds: target.elementIds };
      await createComment(canvasId, target.frameId, body, text.trim());
      setText("");
      props.onClearTarget();
      setFilter("open");
      await reload();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (c: CanvasComment) => {
    if (!note.trim()) return;
    try {
      await resolveComment(canvasId, c.id, note.trim());
      setResolving(null);
      setNote("");
      await reload();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const reopen = async (c: CanvasComment) => {
    try {
      await reopenComment(canvasId, c.id);
      await reload();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const shown = (rows ?? []).filter((c) => filter === "all" || c.status === filter);
  const count = (f: Filter) => (rows ?? []).filter((c) => f === "all" || c.status === f).length;

  return (
    <section className="cv__comments" aria-label="Comments">
      {!props.readOnly && (
        <div className="cv__comment-new">
          <div className="cv__row">
            <button
              type="button"
              className="k-btn k-btn--secondary k-btn--sm"
              disabled={!props.canUseSelection}
              onClick={props.onUseSelection}
              title="Comment on the selected elements"
            >
              <Scan size={14} aria-hidden /> On selection
            </button>
            <button
              type="button"
              className="k-btn k-btn--secondary k-btn--sm"
              onClick={props.onPickArea}
              title="Drag a box on the drawing to comment on that area"
            >
              <SquareDashedMousePointer size={14} aria-hidden /> On an area
            </button>
          </div>
          {props.targetError && <small className="cv__field-error">{props.targetError}</small>}
          {props.target && (
            <form
              className="cv__field"
              onSubmit={(e) => {
                e.preventDefault();
                void post();
              }}
            >
              <span className="cv__meta">
                {props.frameTitle(props.target.frameId)} · {describe(props.target)}
              </span>
              <textarea
                className="cv__input"
                rows={3}
                autoFocus
                aria-label="Comment"
                placeholder="What should change?"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="cv__row">
                <button
                  type="submit"
                  className="k-btn k-btn--primary k-btn--sm"
                  disabled={busy || !text.trim()}
                >
                  <MessageSquarePlus size={14} aria-hidden /> Post
                </button>
                <button
                  type="button"
                  className="k-btn k-btn--ghost k-btn--sm"
                  onClick={props.onClearTarget}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
      <div className="cv__row" role="group" aria-label="Show comments">
        {(["open", "resolved", "all"] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`cv__chip${filter === f ? " is-on" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f} {count(f)}
          </button>
        ))}
      </div>
      {error && <small className="cv__field-error">{error}</small>}
      {rows !== null && shown.length === 0 && (
        <p className="cv__hint">{filter === "open" ? "No open comments." : "Nothing here."}</p>
      )}
      <ul className="cv__comment-list">
        {shown.map((c) => (
          <li key={c.id} className={`cv__comment cv__comment--${c.status}`}>
            <p className="cv__comment-text">{c.text}</p>
            <span className="cv__meta">
              {c.author} · {when(c.createdAt)} · {props.frameTitle(c.frameId)} · {describe(c)}
            </span>
            {c.resolution && (
              <p className="cv__comment-resolution">
                <Check size={12} aria-hidden /> {c.resolution.note}
                <span className="cv__meta">
                  {" "}
                  {c.resolution.by} · {when(c.resolution.at)}
                </span>
              </p>
            )}
            <div className="cv__row">
              <button
                type="button"
                className="k-btn k-btn--ghost k-btn--sm"
                onClick={() => props.onShow(c)}
              >
                Show
              </button>
              {!props.readOnly && c.status === "open" && resolving !== c.id && (
                <button
                  type="button"
                  className="k-btn k-btn--ghost k-btn--sm"
                  onClick={() => {
                    setResolving(c.id);
                    setNote("");
                  }}
                >
                  Resolve
                </button>
              )}
              {!props.readOnly && c.status === "resolved" && (
                <button
                  type="button"
                  className="k-btn k-btn--ghost k-btn--sm"
                  onClick={() => void reopen(c)}
                >
                  <RotateCcw size={12} aria-hidden /> Reopen
                </button>
              )}
            </div>
            {resolving === c.id && (
              <form
                className="cv__field"
                onSubmit={(e) => {
                  e.preventDefault();
                  void resolve(c);
                }}
              >
                <input
                  className="cv__input"
                  autoFocus
                  aria-label="Resolution note"
                  placeholder="What was done"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <div className="cv__row">
                  <button
                    type="submit"
                    className="k-btn k-btn--primary k-btn--sm"
                    disabled={!note.trim()}
                  >
                    Resolve
                  </button>
                  <button
                    type="button"
                    className="k-btn k-btn--ghost k-btn--sm"
                    onClick={() => setResolving(null)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
