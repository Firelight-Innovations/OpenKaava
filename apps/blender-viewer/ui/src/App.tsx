import { useCallback, useEffect, useMemo, useState } from "react";
import { reportPainted } from "@openkaava/bridge";
import { Clock, ExternalLink, MessageSquarePlus, Orbit, Package } from "lucide-react";
import { CommentPanel } from "../../../shared/CommentPanel";
import {
  createComment,
  listComments,
  resolveComment,
  type Comment,
} from "../../../shared/comments";
import { formatRenderAge } from "../../../shared/age";
import { SegmentedControl } from "../../../shared/SegmentedControl";
import { getState, type BlenderPart, type BlenderViewerState } from "./rpc";
import { sampleState } from "./fixtures";
import "./App.css";

type Mode = "model" | "renders" | "wire";

const EMPTY_STATE: BlenderViewerState = { model: null, parts: [], renders: [] };

export default function App() {
  const [mode, setMode] = useState<Mode>("model");
  const [state, setState] = useState<BlenderViewerState>(EMPTY_STATE);
  const [preview, setPreview] = useState(false);
  const [selected, setSelected] = useState<BlenderPart | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

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

  // No render timestamp comes back from the backend yet (see rpc.ts) — the
  // most recent render's createdAt is the best honest stand-in for "age of
  // what's on screen", and null when there isn't one.
  const shown = preview ? sampleState : state;
  const renderedAt =
    shown.renders.length > 0 ? Math.max(...shown.renders.map((r) => r.createdAt)) : null;
  const openCount = useMemo(() => comments.filter((c) => c.status === "open").length, [comments]);

  const postComment = async () => {
    if (!selected || !draft.trim()) return;
    setPosting(true);
    try {
      await createComment({
        anchor: { kind: "mesh", part: selected.name, material: selected.material },
        body: draft.trim(),
      });
      setDraft("");
      await refreshComments();
      setCommentsOpen(true);
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="bv">
      <header className="bv__header">
        <span className="bv__badge">BLENDER VIEWER · READ-ONLY</span>
        <SegmentedControl
          aria-label="View"
          value={mode}
          onChange={setMode}
          options={[
            { value: "model", label: "Model" },
            { value: "renders", label: "Renders" },
            { value: "wire", label: "Wire" },
          ]}
        />
        <span className="bv__age">
          <Clock size={12} strokeWidth={1.5} aria-hidden="true" />
          {formatRenderAge(renderedAt)}
        </span>
        <label className="bv__preview-toggle">
          <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
          Preview with sample data
        </label>
      </header>

      <div className="bv__body">
        {mode === "renders" ? (
          <main className="bv__renders">
            {shown.renders.length === 0 ? (
              <p className="bv__hint">
                No renders yet — the agent's headless Blender export will drop them here.
              </p>
            ) : (
              <div className="bv__renders-strip">
                {shown.renders.map((r) => (
                  <div key={r.id} className="bv__render-tile">
                    <span className="bv__render-tile-label">{r.label}</span>
                    <span className="bv__render-tile-hint">no image preview in this build</span>
                  </div>
                ))}
              </div>
            )}
          </main>
        ) : (
          <>
            <main className={`bv__viewport${mode === "wire" ? " bv__viewport--wire" : ""}`}>
              {shown.model === null ? (
                <p className="bv__hint">
                  No headless export yet — the agent's Blender <code>.glb</code> export will appear
                  here.
                </p>
              ) : (
                <div className="bv__stage">
                  <span className="bv__model-path">{shown.model}</span>
                  <p className="bv__hint">
                    Placeholder — no 3D viewport is wired up in this build.
                  </p>
                  <div className="bv__orbit-hint">
                    <Orbit size={14} strokeWidth={1.5} aria-hidden="true" />
                    Drag to orbit — not wired up yet
                  </div>
                </div>
              )}
            </main>

            <aside className="bv__parts">
              <div className="bv__parts-heading">
                <Package size={13} strokeWidth={1.5} aria-hidden="true" />
                Parts
              </div>
              {shown.parts.length === 0 ? (
                <p className="bv__hint">No parts to list yet.</p>
              ) : (
                <div className="bv__parts-list">
                  {shown.parts.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      className={`bv__part-row${selected?.name === p.name ? " bv__part-row--selected" : ""}`}
                      onClick={() => setSelected(p)}
                    >
                      <span className="bv__part-name">{p.name}</span>
                      <span className="bv__part-material">{p.material}</span>
                    </button>
                  ))}
                </div>
              )}
            </aside>

            {selected && (
              <div className="bv__composer">
                <div className="bv__composer-target">
                  <MessageSquarePlus size={13} strokeWidth={1.5} aria-hidden="true" />
                  Comment on <code>{selected.name}</code> · {selected.material}
                </div>
                <textarea
                  className="bv__composer-input"
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="What should change about this part?"
                />
                <div className="bv__composer-actions">
                  <button type="button" onClick={() => setSelected(null)} disabled={posting}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="bv__composer-submit"
                    onClick={postComment}
                    disabled={posting || !draft.trim()}
                  >
                    {posting ? "Posting…" : "Comment"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {commentsOpen && (
          <CommentPanel
            comments={comments}
            loading={commentsLoading}
            error={commentsError}
            onResolve={async (id, note) => {
              await resolveComment(id, note);
              await refreshComments();
            }}
            emptyHint="No comments on this model yet. Select a part and leave one."
          />
        )}
      </div>

      <footer className="bv__footer">
        <button type="button" className="bv__footer-btn" onClick={() => setCommentsOpen((v) => !v)}>
          <MessageSquarePlus size={13} strokeWidth={1.5} aria-hidden="true" />
          Comments {openCount > 0 ? `· ${openCount} open` : ""}
        </button>
        <button
          type="button"
          className="bv__footer-btn"
          disabled
          title="Not wired yet — there's no Blender install handoff from this build. Ctrl+Shift+O will open it once that exists."
        >
          <ExternalLink size={13} strokeWidth={1.5} aria-hidden="true" />
          Open in Blender
        </button>
      </footer>
    </div>
  );
}
