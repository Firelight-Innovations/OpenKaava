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
import { useSlots } from "./components/registry";
import { strings } from "./strings";

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
  const S = useSlots();
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
  const pending = typeof status?.pendingPrompt === "string" ? status.pendingPrompt : null;
  const exited = status !== null && (status.state === "stopped" || status.state === "failed");

  return (
    <S.Layout
      header={
        <S.Header
          cwd={status?.cwd ?? null}
          harness={strings.harness.claude}
          model={null}
          state={status?.state ?? null}
          onNewSession={() => {
            setNotice(null);
            void rpc.reset().catch(() => {});
          }}
        />
      }
      transcript={
        <S.Transcript ref={transcript} onScroll={onScroll}>
          {state.items.length === 0 && pending === null ? (
            <S.EmptyState
              blocked={blocked}
              setupHint={setupHint && strings.hint[setupHint]}
              onExample={(text) => {
                setDraft(text);
                prompt.current?.focus();
              }}
            />
          ) : (
            state.items.map((item) => <ItemView key={item.id} item={item} actions={actions} />)
          )}
          {pending !== null && <S.UserMessage text={pending} pending />}
          {hint && <S.Hint text={strings.hint[hint]} />}
          {exited && state.items.length > 0 && <S.Note text={strings.exited(status.exitCode)} />}
        </S.Transcript>
      }
      composer={
        <S.Composer
          ref={prompt}
          value={draft}
          placeholder={working ? strings.promptBusy : strings.promptPlaceholder}
          onChange={setDraft}
          onKeyDown={onKeyDown}
          notices={
            <>
              {attachFailed && (
                <S.Notice
                  text={strings.failed.attach}
                  hint={null}
                  action={{ label: strings.retry, onClick: () => void attach() }}
                />
              )}
              {notice && (
                <S.Notice
                  text={notice.text}
                  hint={notice.hint && strings.hint[notice.hint]}
                  action={null}
                />
              )}
            </>
          }
          controls={<S.ModePicker label={strings.mode} value={status?.mode ?? null} choices={[]} />}
          action={
            working ? (
              <S.StopButton onClick={stopTurn} />
            ) : (
              <S.SendButton disabled={draft.trim() === ""} onClick={() => submit(draft)} />
            )
          }
        />
      }
    />
  );
}
