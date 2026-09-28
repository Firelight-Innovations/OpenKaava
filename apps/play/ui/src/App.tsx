import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reportPainted } from "@openkaava/bridge";
import { Camera, ExternalLink, MessageSquarePlus, Pause, Play as PlayIcon, RotateCcw, Square } from "lucide-react";
import { CommentPanel } from "../../../shared/CommentPanel";
import {
  createComment,
  listComments,
  resolveComment,
  formatPlayTime,
  type Comment,
} from "../../../shared/comments";
import { getState, type PlayState } from "./rpc";
import { sampleState } from "./fixtures";
import "./App.css";

const EMPTY_STATE: PlayState = { running: false, build: null };

export default function App() {
  const [state, setState] = useState<PlayState>(EMPTY_STATE);
  const [preview, setPreview] = useState(false);
  const [running, setRunning] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const shown = preview ? sampleState : state;
  const hasBuild = shown.build !== null;

  const refreshComments = useCallback(async () => {
    setCommentsLoading(true);
    setCommentsError(null);
    try {
      setComments(await listComments());
    } catch {
      setCommentsError("Couldn't load comments.");
    } finally {
      setCommentsLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getState();
        if (!cancelled) setState(s);
      } catch {
        // Falls through to the empty state already set.
      }
    })();
    void refreshComments();
    reportPainted();
    return () => {
      cancelled = true;
    };
  }, [refreshComments]);

  // The playhead only advances in preview — there is no real run behind this
  // pane yet (see rpc.ts), so "running" outside preview never becomes true.
  useEffect(() => {
    if (running && preview) {
      tickRef.current = setInterval(() => setPlayhead((t) => t + 0.1), 100);
    }
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [running, preview]);

  const restart = useCallback(() => {
    if (!preview) return;
    setPlayhead(0);
    setRunning(true);
  }, [preview]);

  const stop = useCallback(() => {
    if (!preview) return;
    setRunning(false);
    setPlayhead(0);
  }, [preview]);

  const openCount = useMemo(() => comments.filter((c) => c.status === "open").length, [comments]);

  const postComment = async () => {
    if (!draft.trim() || !shown.build) return;
    setPosting(true);
    try {
      await createComment({
        anchor: { kind: "scene", scene: shown.build.scenePath, time: playhead },
        body: draft.trim(),
      });
      setDraft("");
      setComposerOpen(false);
      await refreshComments();
      setCommentsOpen(true);
    } finally {
      setPosting(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Scoped to this pane, not the whole window — a keydown handler on the
    // app's own root only fires while this iframe has focus, per the
    // workstream brief's "not global" instruction for these two shortcuts.
    if (e.key === "F5") {
      e.preventDefault();
      restart();
    } else if (e.key.toLowerCase() === "c" && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      if (hasBuild) setComposerOpen(true);
    }
  };

  return (
    <div className="pl" tabIndex={0} onKeyDown={onKeyDown}>
      <header className="pl__header">
        <span className="pl__badge">PLAY</span>
        {running && preview && <span className="pl__pill">Playing</span>}
        <div className="pl__transport">
          <button
            type="button"
            className="pl__transport-btn"
            disabled={!preview || !hasBuild}
            title={preview ? (running ? "Pause" : "Play") : "Not wired yet — no run behind this pane."}
            onClick={() => setRunning((v) => !v)}
          >
            {running ? (
              <Pause size={14} strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <PlayIcon size={14} strokeWidth={1.5} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="pl__transport-btn"
            disabled={!preview || !hasBuild}
            title={preview ? "Restart (F5)" : "Not wired yet — no run behind this pane."}
            onClick={restart}
          >
            <RotateCcw size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="pl__transport-btn"
            disabled={!preview || !hasBuild}
            title={preview ? "Stop" : "Not wired yet — no run behind this pane."}
            onClick={stop}
          >
            <Square size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          className="pl__capture"
          disabled={!hasBuild}
          title={hasBuild ? "Capture & comment (Ctrl+Shift+C)" : "No debug build to capture from yet."}
          onClick={() => setComposerOpen(true)}
        >
          <Camera size={13} strokeWidth={1.5} aria-hidden="true" />
          Capture &amp; comment
        </button>
        <label className="pl__preview-toggle">
          <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
          Preview with sample data
        </label>
      </header>

      <div className="pl__body">
        <main className="pl__frame">
          {!hasBuild ? (
            <p className="pl__hint">
              No debug build to play — the agent's build step hasn't produced one yet.
            </p>
          ) : (
            <div className="pl__stage">
              <span className="pl__scene-path">{shown.build?.scenePath}</span>
              <p className="pl__hint">Placeholder — no live game frame is wired up in this build.</p>
              <div className="pl__debug-overlay">
                <span>t={formatPlayTime(playhead)}</span>
                <span>{running && preview ? "running" : "paused"}</span>
              </div>
            </div>
          )}

          {composerOpen && hasBuild && (
            <div className="pl__composer">
              <div className="pl__composer-target">
                <MessageSquarePlus size={13} strokeWidth={1.5} aria-hidden="true" />
                Comment at {formatPlayTime(playhead)}
              </div>
              <textarea
                className="pl__composer-input"
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="What's wrong with this moment?"
                autoFocus
              />
              <p className="pl__composer-note">
                No screenshot is attached — this build doesn't capture the frame yet.
              </p>
              <div className="pl__composer-actions">
                <button type="button" onClick={() => setComposerOpen(false)} disabled={posting}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="pl__composer-submit"
                  onClick={postComment}
                  disabled={posting || !draft.trim()}
                >
                  {posting ? "Posting…" : "Comment"}
                </button>
              </div>
            </div>
          )}
        </main>

        {commentsOpen && (
          <CommentPanel
            comments={comments}
            loading={commentsLoading}
            error={commentsError}
            onResolve={async (id, note) => {
              await resolveComment(id, note);
              await refreshComments();
            }}
            emptyHint="No comments on this run yet. Capture one while playing."
          />
        )}
      </div>

      <footer className="pl__footer">
        <span className="pl__footer-scene">{shown.build?.scenePath ?? "no scene"}</span>
        <span className="pl__footer-time">t={formatPlayTime(playhead)}</span>
        <button type="button" className="pl__footer-btn" onClick={() => setCommentsOpen((v) => !v)}>
          <MessageSquarePlus size={13} strokeWidth={1.5} aria-hidden="true" />
          Comments {openCount > 0 ? `· ${openCount} open` : ""}
        </button>
        <button
          type="button"
          className="pl__footer-btn"
          disabled
          title="Not wired yet — there's no Godot install handoff from this build. Ctrl+Shift+O will open it once that exists."
        >
          <ExternalLink size={13} strokeWidth={1.5} aria-hidden="true" />
          Open in Godot
        </button>
      </footer>
    </div>
  );
}
