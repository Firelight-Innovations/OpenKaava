/**
 * The agent tab: one coding agent's conversation, run in this cluster's
 * worktree (handoff §2.1). Header, transcript, prompt box, top to bottom.
 *
 * The session lives in Rust, not here. On every mount the tab subscribes to
 * its envelopes, then attaches; `model.ts` stitches the two together by `seq`,
 * so a tab hidden and shown again (or dragged to another pane) redraws the
 * whole conversation without missing or doubling anything.
 */
import { useCallback, useEffect, useReducer, useRef, useState, type KeyboardEvent } from "react";
import { reportPainted } from "@openkaava/bridge";
import type { Attachment, Envelope, Hint } from "./protocol.generated";
import { attached, busy, initialState, promptBefore, received, type TabState } from "./model";
import * as rpc from "./rpc";
import { ItemView } from "./Items";
import { strings } from "./strings";
import "./theme/vscode-map.css";
import "./agent-tab.css";

type Action =
  { type: "attached"; attachment: Attachment } | { type: "envelope"; envelope: Envelope };

function reduce(state: TabState, action: Action): TabState {
  return action.type === "attached"
    ? attached(state, action.attachment)
    : received(state, action.envelope);
}

/** A refusal or failure to show above the prompt box, in the tab's words. */
interface Notice {
  text: string;
  hint: Hint | null;
}

function noticeOf(err: unknown, fallback: string): Notice {
  const refusal = rpc.refusalOf(err);
  if (!refusal) return { text: fallback, hint: null };
  return {
    text: strings.refusal[refusal.code] ?? fallback,
    hint: (refusal.hint as Hint | null) ?? null,
  };
}

export default function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [setupHint, setSetupHint] = useState<Hint | null>(null);
  const [attachFailed, setAttachFailed] = useState(false);
  const transcript = useRef<HTMLDivElement | null>(null);
  const prompt = useRef<HTMLTextAreaElement | null>(null);
  // Whether the reader is at the bottom; scrolling up to read stops the
  // follow until they come back down.
  const following = useRef(true);

  // Envelopes are held until this answers, so a retry loses none of them.
  const attach = useCallback(
    () =>
      rpc.attach().then(
        (attachment) => {
          setAttachFailed(false);
          dispatch({ type: "attached", attachment });
        },
        () => setAttachFailed(true),
      ),
    [],
  );

  useEffect(() => {
    const stop = rpc.onEnvelope((envelope) => dispatch({ type: "envelope", envelope }));
    void attach().finally(() => reportPainted());
    rpc
      .harnesses()
      .then((answer) => {
        setBlocked(answer.blocked);
        setSetupHint(answer.harnesses[0]?.hint ?? null);
      })
      .catch(() => {});
    return stop;
  }, [attach]);

  // Follow the conversation while it grows, unless the reader scrolled up.
  const count = state.items.length;
  const tail = state.items[count - 1];
  useEffect(() => {
    const el = transcript.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [count, tail]);

  const onScroll = () => {
    const el = transcript.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const working = busy(state.status);

  const submit = useCallback((text: string) => {
    if (text.trim() === "") return;
    setNotice(null);
    following.current = true;
    rpc.send(text).then(
      // Only if the box still holds what was sent: the user may have typed
      // on while it was in flight, and a Retry sends an older prompt.
      () => setDraft((now) => (now === text ? "" : now)),
      (err: unknown) => setNotice(noticeOf(err, strings.failed.send)),
    );
  }, []);

  const stopTurn = useCallback(() => {
    void rpc.cancel().catch(() => {});
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && working) {
      event.preventDefault();
      stopTurn();
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!working) submit(draft);
    }
  };

  const actions = {
    onAnswer: (itemId: string, optionId: string) =>
      rpc.answer(itemId, optionId).then(
        () => undefined,
        (err: unknown) => {
          setNotice(noticeOf(err, strings.failed.send));
          throw err;
        },
      ),
    onRetry: (itemId: string) => {
      const text = promptBefore(state.items, itemId);
      if (text !== null) submit(text);
    },
  };

  const status = state.status;
  const hint = status?.hint ?? null;
  const hasPending = typeof status?.pendingPrompt === "string";
  const exited = status !== null && (status.state === "stopped" || status.state === "failed");

  return (
    <div className="at">
      <header className="at-header">
        <span className="at-header__title">{strings.title}</span>
        <span className="at-chip">{strings.harness.claude}</span>
        {status && (
          <span className="at-chip at-mono" title={status.cwd}>
            {strings.environment(baseName(status.cwd))}
          </span>
        )}
        <span className={`at-status at-status--${status?.state ?? "idle"}`} role="status">
          <span className="at-status__dot" aria-hidden="true" />
          {status ? strings.state[status.state] : strings.idle}
        </span>
        <span className="at-header__spacer" />
        <button
          type="button"
          className="k-btn k-btn--ghost k-btn--sm"
          title={strings.newSessionHint}
          onClick={() => {
            setNotice(null);
            void rpc.reset().catch(() => {});
          }}
        >
          {strings.newSession}
        </button>
      </header>

      <div className="at-transcript" ref={transcript} onScroll={onScroll}>
        {state.items.length === 0 && !hasPending ? (
          <Empty
            blocked={blocked}
            setupHint={setupHint}
            onExample={(text) => {
              setDraft(text);
              prompt.current?.focus();
            }}
          />
        ) : (
          state.items.map((item) => <ItemView key={item.id} item={item} actions={actions} />)
        )}
        {hasPending && status && (
          <div className="at-item at-user at-user--pending">
            <div className="at-item__label">{strings.you}</div>
            <div className="at-user__text">{status.pendingPrompt}</div>
            <div className="at-note">{strings.starting}</div>
          </div>
        )}
        {hint && <div className="at-hint at-item">{strings.hint[hint]}</div>}
        {exited && state.items.length > 0 && (
          <div className="at-note at-item">{strings.exited(status.exitCode)}</div>
        )}
      </div>

      <footer className="at-prompt">
        {attachFailed && (
          <div className="at-notice" role="alert">
            {strings.failed.attach}{" "}
            <button
              type="button"
              className="k-btn k-btn--secondary k-btn--sm"
              onClick={() => void attach()}
            >
              {strings.retry}
            </button>
          </div>
        )}
        {notice && (
          <div className="at-notice" role="alert">
            {notice.text}
            {notice.hint && <div className="at-hint">{strings.hint[notice.hint]}</div>}
          </div>
        )}
        <textarea
          ref={prompt}
          className="at-prompt__input"
          aria-label={strings.promptLabel}
          placeholder={working ? strings.promptBusy : strings.promptPlaceholder}
          value={draft}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="at-prompt__footer">
          <span className="at-prompt__mode">{status?.mode ?? ""}</span>
          <span className="at-header__spacer" />
          {working ? (
            <button
              type="button"
              className="k-btn k-btn--secondary k-btn--sm"
              title={strings.stopTurnHint}
              onClick={stopTurn}
            >
              {strings.stopTurn}
            </button>
          ) : (
            <button
              type="button"
              className="k-btn k-btn--primary k-btn--sm"
              disabled={draft.trim() === ""}
              onClick={() => submit(draft)}
            >
              {strings.send}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

function Empty({
  blocked,
  setupHint,
  onExample,
}: {
  blocked: string | null;
  setupHint: Hint | null;
  onExample: (text: string) => void;
}) {
  return (
    <div className="at-empty">
      <h2 className="at-empty__heading">{strings.empty.heading}</h2>
      <p>{strings.empty.body}</p>
      {blocked && <p className="at-hint">{strings.refusal[blocked] ?? blocked}</p>}
      {setupHint && <p className="at-hint">{strings.hint[setupHint]}</p>}
      <ul className="at-empty__examples">
        {strings.empty.examples.map((text) => (
          <li key={text}>
            <button
              type="button"
              className="k-btn k-btn--ghost k-btn--sm"
              onClick={() => onExample(text)}
            >
              {text}
            </button>
          </li>
        ))}
      </ul>
      <h3 className="at-empty__keys">{strings.empty.keysHeading}</h3>
      <dl className="at-keys">
        {strings.empty.keys.map(([key, action]) => (
          <div key={key}>
            <dt>
              <kbd>{key}</kbd>
            </dt>
            <dd>{action}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
