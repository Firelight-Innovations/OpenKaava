import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reportPainted } from "@openkaava/bridge";
import {
  Camera,
  ExternalLink,
  MessageSquarePlus,
  Pause,
  Play as PlayIcon,
  RotateCcw,
  Square,
} from "lucide-react";
import { CommentPanel } from "../../../shared/CommentPanel";
import {
  createComment,
  listComments,
  resolveComment,
  formatPlayTime,
  type Comment,
} from "../../../shared/comments";
import { errorText, getStatus, openInGodot, type GodotStatus } from "../../../shared/godot";
import { SendButton, SendFooter, useSendAction } from "../../../shared/SendFooter";
import {
  addonStatus,
  capture,
  getState,
  installAddon,
  removeAddon,
  restart,
  run,
  setPaused,
  stop,
  type AddonStatus,
  type Capture,
  type LogLine,
  type RunInfo,
} from "./rpc";
import { dragContext, putLog, putShot } from "./context";
import "./App.css";

/** Lines kept in the pane; the backend keeps its own, larger, bound. */
const LOG_KEEP = 2000;
const POLL_MS = 500;

export default function App() {
  const [status, setStatus] = useState<GodotStatus | null>(null);
  const [project, setProject] = useState<string | undefined>(undefined);
  const [info, setInfo] = useState<RunInfo | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [addon, setAddon] = useState<AddonStatus | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [shot, setShot] = useState<Capture | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const cursor = useRef(0);
  const runId = useRef<number | null>(null);
  const logEnd = useRef<HTMLDivElement | null>(null);

  const readOnly = status?.environment.readOnly ?? false;
  const found = status?.executable.found ?? null;
  const projects = status?.projects ?? [];
  const chosen = projects.find((p) => p.rel === project) ?? projects[0] ?? null;
  const chosenRel = chosen?.rel;
  const running = info?.state.kind === "running";
  const paused = running && info?.paused === true;
  const canRun = found !== null && chosen !== null && chosen.engineMajor >= 4;

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

  const loadStatus = useCallback(async (refresh: boolean) => {
    try {
      setStatus(await getStatus(refresh));
      setProblem(null);
    } catch (e) {
      setProblem(errorText(e));
    }
  }, []);

  const loadAddon = useCallback(async (rel: string | undefined) => {
    try {
      setAddon(await addonStatus(rel));
    } catch {
      setAddon(null);
    }
  }, []);

  useEffect(() => {
    void loadStatus(false);
    void refreshComments();
    reportPainted();
  }, [loadStatus, refreshComments]);

  useEffect(() => {
    if (chosenRel !== undefined) void loadAddon(chosenRel);
  }, [chosenRel, loadAddon]);

  // One poll loop: the run's state and the log lines after the cursor. A new
  // run id starts a fresh log, refilled from the beginning.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        let s = await getState(cursor.current);
        if (cancelled) return;
        if (!s.run) {
          setInfo(null);
          return;
        }
        if (runId.current !== s.run.id) {
          runId.current = s.run.id;
          cursor.current = 0;
          setLines([]);
          s = await getState(0);
          if (cancelled || !s.run) return;
        }
        setInfo(s.run);
        if (s.log && s.log.lines.length > 0) {
          cursor.current = s.log.nextSeq;
          const fresh = s.log.lines;
          setLines((prev) => [...prev, ...fresh].slice(-LOG_KEEP));
        }
      } catch {
        // A poll that fails is retried on the next tick.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);

  const guarded = useCallback(async (fn: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await fn();
    } catch (e) {
      setProblem(errorText(e));
    }
  }, []);

  const start = useCallback(
    () =>
      guarded(async () => {
        setInfo((await run(chosenRel)).run);
        setShot(null);
      }),
    [chosenRel, guarded],
  );

  const doRestart = useCallback(
    () =>
      guarded(async () => {
        setInfo((await restart(chosenRel)).run);
        void loadAddon(chosenRel);
      }),
    [chosenRel, guarded, loadAddon],
  );

  const doStop = useCallback(() => guarded(async () => setInfo((await stop()).run)), [guarded]);

  const doPause = useCallback(
    () => guarded(async () => setInfo((await setPaused(!paused)).run)),
    [guarded, paused],
  );

  const doCapture = useCallback(async () => {
    setCapturing(true);
    await guarded(async () => {
      setShot(await capture());
    });
    setCapturing(false);
  }, [guarded]);

  const doOpenEditor = useCallback(
    () => guarded(() => openInGodot(chosenRel)),
    [chosenRel, guarded],
  );

  const changeAddon = async (install: boolean) => {
    await guarded(async () => {
      setAddon(install ? await installAddon(chosenRel) : await removeAddon(chosenRel));
      await loadStatus(false);
    });
    setConsentOpen(false);
  };

  const postComment = async () => {
    if (!shot || !draft.trim()) return;
    setPosting(true);
    try {
      await createComment({
        anchor: { kind: "scene", scene: shot.scene || info?.scene || "", time: shot.time },
        body: draft.trim(),
        screenshotBase64: shot.png,
      });
      setDraft("");
      setShot(null);
      await refreshComments();
      setCommentsOpen(true);
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setPosting(false);
    }
  };

  const { sent, send } = useSendAction(setProblem, errorText);

  const openCount = useMemo(() => comments.filter((c) => c.status === "open").length, [comments]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Scoped to this pane: it only fires while this iframe has focus.
    if (e.key === "F5") {
      e.preventDefault();
      if (running) void doRestart();
      else if (canRun) void start();
    } else if (e.key.toLowerCase() === "c" && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      if (running && info?.captureReady) void doCapture();
    } else if (e.key.toLowerCase() === "o" && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      if (found && chosen && !readOnly) void doOpenEditor();
    }
  };

  const stateLabel = !info
    ? "Not running"
    : info.state.kind === "running"
      ? paused
        ? "Paused"
        : "Playing"
      : info.state.kind === "stopped"
        ? "Stopped"
        : `Exited${info.state.code === null ? "" : ` (${info.state.code})`}`;

  const needsAddon = "enable capture below, then restart the game.";
  const captureTitle = !running
    ? "Run the game to capture a frame."
    : !info?.captureReady
      ? `Capture needs the capture addon - ${needsAddon}`
      : "Capture & comment (Ctrl+Shift+C)";
  const pauseTitle =
    running && !info?.captureReady
      ? `Pausing needs the capture addon - ${needsAddon}`
      : paused
        ? "Resume"
        : "Pause";

  const showNotices =
    problem !== null || (status !== null && (!found || projects.length === 0 || readOnly));

  return (
    <div className="pl" tabIndex={0} onKeyDown={onKeyDown}>
      <header className="pl__header">
        <span className="pl__badge">PLAY</span>
        <span className={`pl__pill${running ? " pl__pill--live" : ""}`}>{stateLabel}</span>
        <div className="pl__transport">
          <button
            type="button"
            className="pl__transport-btn"
            disabled={!canRun || running}
            title={canRun ? "Run the project (F5)" : "Nothing to run yet - see the message below."}
            aria-label="Run"
            onClick={() => void start()}
          >
            <PlayIcon size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="pl__transport-btn"
            disabled={!running || !info?.captureReady}
            title={pauseTitle}
            aria-label={paused ? "Resume" : "Pause"}
            onClick={() => void doPause()}
          >
            {paused ? (
              <PlayIcon size={14} strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <Pause size={14} strokeWidth={1.5} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="pl__transport-btn"
            disabled={!canRun}
            title="Restart (F5 while running)"
            aria-label="Restart"
            onClick={() => void doRestart()}
          >
            <RotateCcw size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="pl__transport-btn"
            disabled={!running}
            title="Stop - ends the game and everything it started"
            aria-label="Stop"
            onClick={() => void doStop()}
          >
            <Square size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          className="pl__capture"
          disabled={!running || !info?.captureReady || capturing}
          title={captureTitle}
          onClick={() => void doCapture()}
        >
          <Camera size={13} strokeWidth={1.5} aria-hidden="true" />
          {capturing ? "Capturing..." : "Capture & comment"}
        </button>
        {projects.length > 1 && (
          <select
            className="pl__select"
            aria-label="Godot project"
            value={chosen?.rel ?? ""}
            disabled={running}
            onChange={(e) => setProject(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.rel} value={p.rel}>
                {p.name} ({p.rel})
              </option>
            ))}
          </select>
        )}
      </header>

      {showNotices && (
        <div className="pl__notices">
          {problem && <p className="pl__notice pl__notice--error">{problem}</p>}
          {status && !found && (
            <p className="pl__notice">
              Godot 4 was not found.
              {status.executable.problems.length > 0 && ` ${status.executable.problems[0]}`} Set its
              path under Settings, Godot, or put it on PATH.{" "}
              <button type="button" className="pl__link" onClick={() => void loadStatus(true)}>
                Check again
              </button>
            </p>
          )}
          {status && projects.length === 0 && (
            <p className="pl__notice">
              No <code>project.godot</code> in this environment (looked four folders deep).
            </p>
          )}
          {chosen && chosen.engineMajor < 4 && (
            <p className="pl__notice">
              {chosen.name} is a Godot 3 project. Kaava drives Godot 4.x.
            </p>
          )}
          {readOnly && (
            <p className="pl__notice">
              This is the main checkout, which is read-only here. Play still runs; enabling capture
              and Open in Godot need a worktree.
            </p>
          )}
        </div>
      )}

      <div className="pl__body">
        <main className="pl__frame">
          {lines.length === 0 ? (
            <p className="pl__hint">
              {info
                ? "Waiting for the game to print something."
                : canRun
                  ? "Press F5 to run the project. Its output appears here; the game opens in its own window."
                  : "Nothing is running."}
            </p>
          ) : (
            <div className="pl__log" role="log" aria-label="Game output">
              {lines.map((l) => (
                <div key={l.seq} className={`pl__line pl__line--${l.level}`}>
                  {l.text}
                </div>
              ))}
              <div ref={logEnd} />
            </div>
          )}

          {shot && (
            <div className="pl__composer">
              <div className="pl__composer-target">
                <MessageSquarePlus size={13} strokeWidth={1.5} aria-hidden="true" />
                Comment at {formatPlayTime(shot.time)} in {shot.scene || "the running scene"}
              </div>
              <img
                className="pl__shot"
                alt="Captured frame"
                src={`data:image/png;base64,${shot.png}`}
                draggable={false}
                title="Drag onto a terminal to send to the agent"
                onPointerDown={dragContext(() => putShot(shot))}
              />
              <textarea
                className="pl__composer-input"
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="What's wrong with this moment?"
                autoFocus
              />
              <div className="pl__composer-actions">
                <button type="button" onClick={() => setShot(null)} disabled={posting}>
                  Discard
                </button>
                <button
                  type="button"
                  className="pl__composer-submit"
                  onClick={() => void postComment()}
                  disabled={posting || !draft.trim()}
                >
                  {posting ? "Posting..." : "Comment"}
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

      {consentOpen && chosen && (
        <div className="pl__consent" role="dialog" aria-label="Enable capture">
          <p>
            Capture adds one small script, <code>addons/kaava/kaava_capture.gd</code>, and one line
            under <code>[autoload]</code> in{" "}
            <code>{chosen.rel === "." ? "" : `${chosen.rel}/`}project.godot</code>. While the game
            runs it listens in a temporary folder for a capture, pause or resume request from this
            pane. It opens no network connection and can be removed here at any time, which puts{" "}
            <code>project.godot</code> back.
          </p>
          <div className="pl__composer-actions">
            <button type="button" onClick={() => setConsentOpen(false)}>
              Not now
            </button>
            <button
              type="button"
              className="pl__composer-submit"
              onClick={() => void changeAddon(true)}
            >
              Add to this project
            </button>
          </div>
        </div>
      )}

      <SendFooter
        trailing={
          <>
            <span className="pl__footer-scene">
              {info?.scene ?? chosen?.mainScenePath ?? chosen?.mainScene ?? "no scene"}
            </span>
            {found && (
              <span className="pl__footer-time">
                Godot {found.version.split(".").slice(0, 2).join(".")}
              </span>
            )}
            {chosen && addon && !readOnly && (
              <button
                type="button"
                className="pl__footer-btn"
                onClick={() =>
                  addon.addon === "yes" ? void changeAddon(false) : setConsentOpen(true)
                }
                title={
                  addon.addon === "yes"
                    ? "Remove the capture script and its project.godot line."
                    : "Add the capture script so Play can screenshot and pause the game."
                }
              >
                {addon.addon === "yes" ? "Disable capture" : "Enable capture"}
                {addon.needsRestart ? " (restart the game)" : ""}
              </button>
            )}
            <button
              type="button"
              className="pl__footer-btn"
              onClick={() => setCommentsOpen((v) => !v)}
            >
              <MessageSquarePlus size={13} strokeWidth={1.5} aria-hidden="true" />
              Comments {openCount > 0 ? `· ${openCount} open` : ""}
            </button>
            <button
              type="button"
              className="pl__footer-btn"
              disabled={!found || !chosen || readOnly}
              onClick={() => void doOpenEditor()}
              title={
                readOnly
                  ? "The default branch is read-only; open a worktree to edit."
                  : found
                    ? "Open this project in the Godot editor (Ctrl+Shift+O)"
                    : "Godot 4 was not found."
              }
            >
              <ExternalLink size={13} strokeWidth={1.5} aria-hidden="true" />
              Open in Godot
            </button>
          </>
        }
      >
        <SendButton
          label="Send log"
          sent={sent === "log"}
          disabled={lines.length === 0}
          title="Send the last lines of the game's output to the agent, or drag this onto a terminal"
          onClick={() => void send("log", "log", () => putLog(lines, info?.scene ?? null))}
          onPointerDown={dragContext(() => putLog(lines, info?.scene ?? null))}
        />
        {shot && (
          <SendButton
            label="Send frame"
            sent={sent === "frame"}
            title="Send the captured frame to the agent, or drag this onto a terminal"
            onClick={() => void send("frame", "frame", () => putShot(shot))}
            onPointerDown={dragContext(() => putShot(shot))}
          />
        )}
      </SendFooter>
    </div>
  );
}
