import { useCallback, useEffect, useMemo, useState } from "react";
import { openIn, reportPainted } from "@openkaava/bridge";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FolderTree,
  Image as ImageIcon,
  MessageSquarePlus,
  RefreshCw,
} from "lucide-react";
import { CommentPanel } from "../../../shared/CommentPanel";
import {
  createComment,
  listComments,
  resolveComment,
  type Comment,
} from "../../../shared/comments";
import { formatRenderAge } from "../../../shared/age";
import { errorText, getStatus, openInGodot, type GodotStatus } from "../../../shared/godot";
import { SegmentedControl } from "../../../shared/SegmentedControl";
import { getImage, getState, refresh, type GodotNode, type GodotViewerState } from "./rpc";
import { sampleState } from "./fixtures";
import "./App.css";

type Mode = "scene" | "play";

const POLL_MS = 600;

export default function App() {
  const [mode, setMode] = useState<Mode>("scene");
  const [state, setState] = useState<GodotViewerState | null>(null);
  const [scene, setScene] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<GodotStatus | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
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

  const load = useCallback(async () => {
    try {
      const s = await getState(scene);
      setState(s);
      setProblem(null);
      setImage(s.imageAt === null ? null : (await getImage(s.scene ?? undefined)).png);
    } catch (e) {
      setProblem(errorText(e));
    }
  }, [scene]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    getStatus(false)
      .then(setStatus)
      .catch(() => setStatus(null));
    void refreshComments();
    reportPainted();
  }, [refreshComments]);

  // While a refresh runs, poll for its phase; when it stops, load the result.
  const jobRunning = state?.job?.running === true;
  useEffect(() => {
    if (!jobRunning) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [jobRunning, load]);

  const startRefresh = async (render: boolean) => {
    setProblem(null);
    try {
      await refresh(state?.scene ?? scene, render);
      await load();
    } catch (e) {
      setProblem(errorText(e));
    }
  };

  const shown = preview ? sampleState : state;
  const nodes = shown?.nodes ?? [];
  const found = status?.executable.found ?? null;
  const readOnly = status?.environment.readOnly ?? false;
  const openCount = useMemo(() => comments.filter((c) => c.status === "open").length, [comments]);
  const job = preview ? null : (state?.job ?? null);
  const busy = job?.running === true;
  const noScenes = !preview && state !== null && state.scenes.length === 0;

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

  const sourceLabel =
    shown?.source === "headless"
      ? `Read by ${shown.godot ? `Godot ${shown.godot.split(".").slice(0, 2).join(".")}` : "Godot"} (headless)`
      : shown?.source === "parsed"
        ? "Read from the scene file - Godot did not run"
        : null;

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
        {!preview && state && state.scenes.length > 0 && (
          <select
            className="gv__select"
            aria-label="Scene"
            value={state.scene ?? ""}
            disabled={busy}
            onChange={(e) => {
              setScene(e.target.value);
              setSelected(null);
            }}
          >
            {state.scenes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        <span className="gv__age">
          <Clock size={12} strokeWidth={1.5} aria-hidden="true" />
          {formatRenderAge(shown?.renderedAt ?? null)}
        </span>
        <label className="gv__preview-toggle">
          <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
          Preview with sample data
        </label>
      </header>

      {(problem || job?.error || (!preview && state && !state.engineFound)) && (
        <div className="gv__notices">
          {problem && <p className="gv__notice gv__notice--error">{problem}</p>}
          {job?.error && (
            <p className="gv__notice gv__notice--error">
              {job.error}
              {job.output.length > 0 && <code className="gv__output">{job.output.join("\n")}</code>}
            </p>
          )}
          {!preview && state && !state.engineFound && (
            <p className="gv__notice">
              Godot 4 was not found, so the tree is read from the scene file and no frame can be
              rendered. Set its path under Settings, Godot.
            </p>
          )}
        </div>
      )}

      <div className="gv__body">
        {mode === "scene" ? (
          <>
            <aside className="gv__tree">
              <div className="gv__tree-heading">
                <FolderTree size={13} strokeWidth={1.5} aria-hidden="true" />
                Scene tree
              </div>
              {nodes.length === 0 ? (
                <p className="gv__hint">
                  {noScenes
                    ? "No .tscn scenes in this project."
                    : "Nothing read yet. Refresh the tree to load it."}
                </p>
              ) : (
                <div className="gv__tree-list">
                  {nodes.map((n) => (
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
              <div className="gv__actions">
                <button
                  type="button"
                  className="gv__action"
                  disabled={preview || busy || noScenes || !state}
                  onClick={() => void startRefresh(false)}
                >
                  <RefreshCw size={13} strokeWidth={1.5} aria-hidden="true" />
                  Refresh tree
                </button>
                <button
                  type="button"
                  className="gv__action"
                  disabled={preview || busy || noScenes || !state?.engineFound}
                  title={
                    state?.engineFound === false
                      ? "Rendering needs Godot 4."
                      : "Opens a Godot window for a moment and saves one frame."
                  }
                  onClick={() => void startRefresh(true)}
                >
                  <ImageIcon size={13} strokeWidth={1.5} aria-hidden="true" />
                  Render view
                </button>
                {busy && <span className="gv__phase">{job?.phase}...</span>}
                {sourceLabel && !busy && <span className="gv__phase">{sourceLabel}</span>}
              </div>
              {shown?.note && !busy && <p className="gv__note">{shown.note}</p>}
              {shown?.scenePath == null ? (
                <p className="gv__hint">
                  {noScenes
                    ? "This project has no scenes yet."
                    : "No render yet. Refresh the tree to read this scene, or Render view for a frame."}
                </p>
              ) : (
                <div className="gv__render">
                  <span className="gv__render-path">{shown.scenePath}</span>
                  {image && !preview ? (
                    <>
                      <img
                        className="gv__frame"
                        alt="Rendered frame of the scene"
                        src={`data:image/png;base64,${image}`}
                      />
                      <span className="gv__frame-age">
                        {formatRenderAge(shown.imageAt).replace("rendered", "frame rendered")}
                      </span>
                    </>
                  ) : (
                    <p className="gv__hint">
                      {preview
                        ? "Sample data - no frame."
                        : "No frame rendered. Use Render view to save one."}
                    </p>
                  )}
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
                    {posting ? "Posting..." : "Comment"}
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="gv__play-redirect">
            <p className="gv__hint">
              Play runs in its own pane, with transport controls and Capture &amp; comment. This
              viewer only shows the scene as Godot last read it.
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
          disabled={!found || readOnly}
          title={
            readOnly
              ? "The main checkout is read-only; open a worktree to edit."
              : found
                ? "Open this project in the Godot editor"
                : "Godot 4 was not found."
          }
          onClick={() => {
            setProblem(null);
            openInGodot().catch((e) => setProblem(errorText(e)));
          }}
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
        title={[node.script, node.instance].filter(Boolean).join("\n") || undefined}
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
