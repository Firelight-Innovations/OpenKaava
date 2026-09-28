import { useCallback, useEffect, useMemo, useState } from "react";
import { openIn, reportPainted } from "@openkaava/bridge";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FolderTree,
  MessageSquarePlus,
} from "lucide-react";
import { CommentPanel } from "../../../shared/CommentPanel";
import {
  createComment,
  listComments,
  resolveComment,
  type Comment,
} from "../../../shared/comments";
import { formatRenderAge } from "../../../shared/age";
import { SegmentedControl } from "../../../shared/SegmentedControl";
import { getState, type GodotNode, type GodotViewerState } from "./rpc";
import { sampleState } from "./fixtures";
import "./App.css";

type Mode = "scene" | "play";

const EMPTY_STATE: GodotViewerState = { renderedAt: null, scenePath: null, nodes: [] };

export default function App() {
  const [mode, setMode] = useState<Mode>("scene");
  const [state, setState] = useState<GodotViewerState>(EMPTY_STATE);
  const [preview, setPreview] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
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
        // The pane still renders an honest empty state; nothing else to do.
      }
    })();
    void refreshComments();
    reportPainted();
    return () => {
      cancelled = true;
    };
  }, [refreshComments]);

  const shown = preview ? sampleState : state;
  const openCount = useMemo(() => comments.filter((c) => c.status === "open").length, [comments]);

  const postComment = async () => {
    if (!selected || !draft.trim()) return;
    setPosting(true);
    try {
      await createComment({ anchor: { kind: "node", path: selected }, body: draft.trim() });
      setDraft("");
      await refreshComments();
      setCommentsOpen(true);
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="gv">
      <header className="gv__header">
        <span className="gv__badge">GODOT VIEWER · READ-ONLY</span>
        <SegmentedControl
          aria-label="View"
          value={mode}
          onChange={setMode}
          options={[
            { value: "scene", label: "Scene" },
            { value: "play", label: "Play" },
          ]}
        />
        <span className="gv__age">
          <Clock size={12} strokeWidth={1.5} aria-hidden="true" />
          {formatRenderAge(shown.renderedAt)}
        </span>
        <label className="gv__preview-toggle">
          <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
          Preview with sample data
        </label>
      </header>

      <div className="gv__body">
        {mode === "scene" ? (
          <>
            <aside className="gv__tree">
              <div className="gv__tree-heading">
                <FolderTree size={13} strokeWidth={1.5} aria-hidden="true" />
                Scene tree
              </div>
              {shown.nodes.length === 0 ? (
                <p className="gv__hint">
                  No headless render yet — the agent's <code>godot --headless</code> run will appear
                  here.
                </p>
              ) : (
                <div className="gv__tree-list">
                  {shown.nodes.map((n) => (
                    <TreeRow
                      key={n.path}
                      node={n}
                      depth={0}
                      selected={selected}
                      onSelect={setSelected}
                    />
                  ))}
                </div>
              )}
            </aside>

            <main className="gv__viewport">
              {shown.scenePath === null ? (
                <p className="gv__hint">
                  No render to show. Once an agent runs Godot headless against this project, its
                  output appears here.
                </p>
              ) : (
                <div className="gv__render">
                  <span className="gv__render-path">{shown.scenePath}</span>
                  <p className="gv__hint">
                    Placeholder — the actual rendered frame from the headless run isn't wired up in
                    this build.
                  </p>
                </div>
              )}
            </main>

            {selected && (
              <div className="gv__composer">
                <div className="gv__composer-target">
                  <MessageSquarePlus size={13} strokeWidth={1.5} aria-hidden="true" />
                  Comment on <code>{selected}</code>
                </div>
                <textarea
                  className="gv__composer-input"
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="What should change about this node?"
                />
                <div className="gv__composer-actions">
                  <button type="button" onClick={() => setSelected(null)} disabled={posting}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="gv__composer-submit"
                    onClick={postComment}
                    disabled={posting || !draft.trim()}
                  >
                    {posting ? "Posting…" : "Comment"}
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="gv__play-redirect">
            <p className="gv__hint">
              Play runs in its own pane, with transport controls and Capture &amp; comment. This
              viewer only shows the scene Godot last rendered headless.
            </p>
            <button
              type="button"
              className="gv__open-play"
              onClick={() => {
                void openIn("play");
              }}
            >
              Open Play
            </button>
          </div>
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
            emptyHint="No comments on this scene yet. Select a node and leave one."
          />
        )}
      </div>

      <footer className="gv__footer">
        <button type="button" className="gv__footer-btn" onClick={() => setCommentsOpen((v) => !v)}>
          <MessageSquarePlus size={13} strokeWidth={1.5} aria-hidden="true" />
          Comments {openCount > 0 ? `· ${openCount} open` : ""}
        </button>
        <button
          type="button"
          className="gv__footer-btn"
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

function TreeRow({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: GodotNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <div className="gv__tree-node">
      <div
        className={`gv__tree-row${selected === node.path ? " gv__tree-row--selected" : ""}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={() => onSelect(node.path)}
      >
        {hasChildren ? (
          <button
            type="button"
            className="gv__tree-toggle"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? (
              <ChevronDown size={12} strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <ChevronRight size={12} strokeWidth={1.5} aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className="gv__tree-toggle-spacer" />
        )}
        <span className="gv__tree-name">{node.name}</span>
        <span className="gv__tree-type">{node.type}</span>
      </div>
      {hasChildren && expanded && (
        <div>
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
