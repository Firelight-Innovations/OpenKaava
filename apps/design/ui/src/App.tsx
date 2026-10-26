/**
 * Design Mode: a page you are building, beside what a click on it produced.
 *
 * The layout is two columns and stays two columns, because the pair is the
 * point. Clicking an element and then losing sight of the page in order to read
 * what was captured is how somebody ends up unsure which element they picked.
 *
 * This component owns no sequencing — `useProbeFrame` does, and its header says
 * why the order matters. What is here is the address bar, the pick toggle, the
 * panel that reads out a capture, and the box that turns one into a comment.
 *
 * **Leaving a comment is the primary action; copying is the fallback.** The
 * clipboard is kept because it still works and costs one button, and it is what
 * a chat client wants. What it cannot do is reach an agent in a terminal, which
 * is the whole reason `design_comments` and `mcp::servers::design` exist.
 */
import { useEffect, useRef, useState } from "react";
import { reportPainted } from "@veistra/bridge";
import CommentList from "./CommentList";
import { CLOSED_BY_HAND } from "./comments";
import { copyForAgent, type Handoff } from "./handoff";
import { toLabel, toPrompt } from "./prompt";
import { useComments } from "./useComments";
import { useProbeFrame } from "./useProbeFrame";

/** What the frame is allowed to do. Read the omissions rather than the list:
 *  there is no `allow-top-navigation`, so the page cannot replace the Veistra
 *  window with itself — which a cross-origin frame may otherwise do off a user
 *  gesture, and a click on an element is a user gesture. */
const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals";

const HANDOFF_WORDING: Record<Handoff, string> = {
  text: "Copied. Paste it into an agent's terminal.",
  "text-and-image": "Copied, with the screenshot beside it.",
  failed: "The clipboard refused the write.",
};

export default function App() {
  const {
    frameRef,
    target,
    generation,
    phase,
    notice,
    captured,
    onFrameLoad,
    load,
    togglePicking,
    dismiss,
  } = useProbeFrame();
  const book = useComments();
  const [address, setAddress] = useState("");
  const [request, setRequest] = useState("");
  const [handoff, setHandoff] = useState<string | null>(null);
  const painted = useRef(false);

  // The right moment is the *content*, and this app's first content is the
  // empty state: there is nothing to fetch before it can be drawn, and holding
  // the splash back for a frame that is already right would only make the
  // window slower to appear. See `apps/README.md`.
  useEffect(() => {
    if (painted.current) return;
    painted.current = true;
    reportPainted();
  }, []);

  const picking = phase === "picking";

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setHandoff(null);
    load(address);
  };

  const copy = async () => {
    if (!captured) return;
    setHandoff(HANDOFF_WORDING[await copyForAgent(captured.element, captured.shot)]);
  };

  // Clears the capture on success, because a comment left is a capture spent:
  // leaving a second one on the same element is a deliberate act that starts
  // with picking it again, not with the box still being open.
  const leave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!captured || request.trim() === "") return;
    const left = await book.leave(captured.element, request, captured.shot?.dataUrl ?? null);
    if (!left) return;
    setRequest("");
    setHandoff(null);
    dismiss();
  };

  return (
    <div className="app design">
      <form className="design__bar" onSubmit={submit}>
        <input
          className="design__address"
          type="text"
          value={address}
          spellCheck={false}
          placeholder="localhost:5173"
          aria-label="Address of the page to inspect"
          onChange={(event) => setAddress(event.target.value)}
        />
        <button className="design__go" type="submit" disabled={address.trim() === ""}>
          {target ? "Reload" : "Open"}
        </button>
        <button
          className="design__pick"
          type="button"
          onClick={togglePicking}
          aria-pressed={picking}
          disabled={phase !== "ready" && !picking}
        >
          {picking ? "Picking — Esc to stop" : "Pick element"}
        </button>
        {target ? <span className="design__origin">{target.origin}</span> : null}
      </form>

      {notice ? <p className="design__notice">{notice}</p> : null}

      <div className="design__split">
        <div className="design__stage">
          {target ? (
            <iframe
              // Remounts on every load, so re-opening the address already
              // showing is a real reload rather than a no-op. See `generation`.
              key={generation}
              ref={frameRef}
              className="design__frame"
              src={target.url}
              sandbox={FRAME_SANDBOX}
              title="The page under inspection"
              onLoad={onFrameLoad}
            />
          ) : (
            <div className="design__empty">
              <p>Open a page you are working on — your dev server, usually.</p>
              <p className="design__hint">
                Then pick an element and say what you want changed. Its markup, its computed styles
                and a picture of it are kept with your comment, and an agent in any terminal reads
                the lot over MCP.
              </p>
            </div>
          )}
        </div>

        <aside className="design__panel">
          {captured ? (
            <section className="design__capture">
              <header className="design__panelhead">
                <h2 className="design__panelname">{toLabel(captured.element)}</h2>
                <button className="design__plain" type="button" onClick={dismiss}>
                  Clear
                </button>
              </header>

              {captured.shot ? (
                <img className="design__shot" src={captured.shot.dataUrl} alt="" />
              ) : (
                <p className="design__shotmiss">{captured.shotProblem ?? "Taking the picture…"}</p>
              )}

              <form className="design__compose" onSubmit={(event) => void leave(event)}>
                <textarea
                  className="design__request"
                  value={request}
                  rows={3}
                  placeholder="What should change about this?"
                  aria-label="What should change about the element you picked"
                  onChange={(event) => setRequest(event.target.value)}
                />
                <div className="design__actions">
                  <button className="design__copy" type="submit" disabled={request.trim() === ""}>
                    Leave comment
                  </button>
                  <button className="design__plain" type="button" onClick={() => void copy()}>
                    Copy instead
                  </button>
                  {handoff ? <span className="design__said">{handoff}</span> : null}
                </div>
              </form>

              {/* Collapsed, because this is now the fallback path. It was the
                  whole panel when the only way out of this app was a paste. */}
              <details className="design__details">
                <summary>What an agent is given</summary>
                <pre className="design__prompt">
                  {toPrompt(captured.element, { withScreenshot: captured.shot !== null })}
                </pre>
              </details>
            </section>
          ) : (
            <p className="design__idle">
              {picking
                ? "Click an element in the page."
                : "Nothing picked yet. Open a page, then use Pick element."}
            </p>
          )}

          {/* A failed *write* only. `useComments` swallows a failed read on
              purpose — one repeats in three seconds, and a notice that appears
              and disappears on its own teaches nobody anything. */}
          {book.problem ? <p className="design__problem">{book.problem}</p> : null}

          <CommentList
            comments={book.comments}
            showing={target?.url ?? null}
            onReply={(id, text) => void book.reply(id, text)}
            onResolve={(id) => void book.resolve(id, CLOSED_BY_HAND)}
            onForget={(id) => void book.forget(id)}
          />
        </aside>
      </div>
    </div>
  );
}
