import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { anchorLabel, type Comment } from "./comments";
import { SendButton, SendFooter } from "./SendFooter";
import "./comment-panel.css";

/**
 * The comment list every viewer shows — board 05's Comments aside, reused
 * across the Godot Viewer, the Blender Viewer and Play rather than redrawn
 * three times. What differs between the three call sites is how a comment
 * gets *created* (a node click, a mesh-part click, Play's Capture & comment),
 * which is why this component takes comments rather than building them: each
 * app owns its own composer and calls {@link import("./comments").createComment}
 * itself, then re-lists.
 */
export interface CommentPanelProps {
  comments: Comment[];
  loading: boolean;
  error: string | null;
  onResolve: (id: string, note: string) => void | Promise<void>;
  /** What to say when there is nothing to show — each viewer's own honest
   *  empty-state sentence, per the workstream brief's "never leave a dead
   *  button, never fake data" rule. */
  emptyHint: string;
}

export function CommentPanel({
  comments,
  loading,
  error,
  onResolve,
  emptyHint,
}: CommentPanelProps) {
  const open = comments.filter((c) => c.status === "open").sort((a, b) => b.created - a.created);
  const resolved = comments
    .filter((c) => c.status === "resolved")
    .sort((a, b) => b.created - a.created);

  return (
    <div className="k-comment-panel">
      <div className="k-comment-panel__header">
        <span className="k-comment-panel__title">Comments</span>
        {!loading && !error && (
          <span className="k-comment-panel__count">
            {open.length} open · {resolved.length} resolved
          </span>
        )}
      </div>

      <div className="k-comment-panel__body">
        {loading && <p className="k-comment-panel__hint">Loading comments…</p>}
        {error && <p className="k-comment-panel__hint k-comment-panel__hint--error">{error}</p>}
        {!loading && !error && comments.length === 0 && (
          <p className="k-comment-panel__hint">{emptyHint}</p>
        )}
        {!loading &&
          !error &&
          [...open, ...resolved].map((comment) => (
            <CommentCard key={comment.id} comment={comment} onResolve={onResolve} />
          ))}
      </div>

      <p className="k-comment-panel__footer-note">
        Comments are files in <code>.kaava/comments/</code>, inside this environment.
      </p>
      <SendFooter>
        <SendButton
          label="Send to agent now"
          disabled
          title="Nothing reads .kaava/comments/ into an agent yet — this button has nothing to nudge."
        />
      </SendFooter>
    </div>
  );
}

function CommentCard({
  comment,
  onResolve,
}: {
  comment: Comment;
  onResolve: (id: string, note: string) => void | Promise<void>;
}) {
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await onResolve(comment.id, note.trim() || "Resolved.");
      setResolving(false);
      setNote("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`k-comment-card k-comment-card--${comment.status}`}>
      <div className="k-comment-card__meta">
        <span className="k-comment-card__anchor">{anchorLabel(comment.anchor)}</span>
        <span className={`k-badge k-badge--${comment.status === "open" ? "info" : "success"}`}>
          <span className="k-badge__dot" aria-hidden="true" />
          {comment.status === "open" ? "Open" : "Resolved"}
        </span>
      </div>
      <p className="k-comment-card__body">{comment.body}</p>

      {comment.status === "resolved" && comment.resolution && (
        <p className="k-comment-card__resolution">
          <CircleCheck size={12} strokeWidth={1.5} aria-hidden="true" />
          {comment.resolution.note}
        </p>
      )}

      {comment.status === "open" && !resolving && (
        <button
          type="button"
          className="k-comment-card__resolve"
          onClick={() => setResolving(true)}
        >
          Resolve with a note
        </button>
      )}

      {comment.status === "open" && resolving && (
        <div className="k-comment-card__resolve-form">
          <textarea
            className="k-comment-card__resolve-input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What changed?"
            rows={2}
            autoFocus
          />
          <div className="k-comment-card__resolve-actions">
            <button type="button" onClick={() => setResolving(false)} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="k-comment-card__resolve-confirm"
              onClick={submit}
              disabled={busy}
            >
              {busy ? "Resolving…" : "Resolve"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
