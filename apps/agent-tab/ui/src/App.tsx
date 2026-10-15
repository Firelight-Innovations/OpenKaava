/**
 * The agent tab: one coding agent's conversation, run in this cluster's
 * worktree (handoff §2.1). Header, transcript, prompt box, top to bottom.
 *
 * The session lives in Rust, not here. On every mount the tab subscribes to
 * its envelopes, then attaches; `model.ts` stitches the two together by `seq`,
 * so a tab hidden and shown again (or dragged to another pane) redraws the
 * whole conversation without missing or doubling anything.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
} from "@assistant-ui/react";
import { reportPainted } from "@openkaava/bridge";
import type { Attachment, Envelope, Hint } from "./protocol.generated";
import { latestUsage } from "./meters";
import { attached, busy, initialState, promptBefore, received, type TabState } from "./model";
import * as rpc from "./rpc";
import { toTurns, type Turn } from "./thread";
import { Turns, TurnsProvider } from "./Turns";
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
  const prompt = useRef<HTMLTextAreaElement | null>(null);

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

  const working = busy(state.status);

  const submit = useCallback((text: string) => {
    if (text.trim() === "") return;
    setNotice(null);
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

  const actions = useMemo(
    () => ({
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
    }),
    [state.items, submit],
  );

  // The transcript as assistant-ui's thread. Turns whose items did not change
  // keep their identity, and `convertMessage` is one function for the tab's
  // life, so assistant-ui converts again only the turn the agent is writing.
  // The lookup changes only with the items, so typing a prompt redraws none.
  // A new envelope still redraws every item: only the conversion is spared.
  const [turns, setTurns] = useState<{ items: TabState["items"]; turns: Turn[] }>({
    items: [],
    turns: [],
  });
  if (turns.items !== state.items) {
    setTurns({ items: state.items, turns: toTurns(state.items, turns.turns) });
  }
  const waiting = state.status?.state === "needsInput";
  const lookup = useMemo(
    () => ({ byId: new Map(state.items.map((item) => [item.id, item])), actions, waiting }),
    [state.items, actions, waiting],
  );
  const runtime = useExternalStoreRuntime({
    messages: turns.turns,
    convertMessage,
    isRunning: working,
    onNew: async (message: AppendMessage) => submit(textOf(message)),
    onCancel: async () => stopTurn(),
  });

  const status = state.status;
  const hint = status?.hint ?? null;
  const pending = typeof status?.pendingPrompt === "string" ? status.pendingPrompt : null;
  const exited = status !== null && (status.state === "stopped" || status.state === "failed");

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TurnsProvider value={lookup}>
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
            <S.Transcript>
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
                <Turns />
              )}
              {pending !== null && <S.UserMessage text={pending} pending />}
              {hint && <S.Hint text={strings.hint[hint]} />}
              {exited && state.items.length > 0 && (
                <S.Note text={strings.exited(status.exitCode)} />
              )}
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
              controls={
                <S.ModelMenu
                  label={strings.settings}
                  sections={[
                    {
                      label: strings.agent,
                      value: status?.harness ?? "claude",
                      choices: [{ value: "claude", name: strings.harness.claude }],
                    },
                    { label: strings.mode, value: status?.mode ?? null, choices: [] },
                  ]}
                />
              }
              meters={
                <>
                  <S.ContextMeter {...latestUsage(state.items)} />
                  <S.UsageRing limits={[]} />
                </>
              }
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
      </TurnsProvider>
    </AssistantRuntimeProvider>
  );
}

/** Module-level: a new function each render would make assistant-ui drop its
 *  cache and convert every turn again. */
function convertMessage(turn: Turn) {
  return turn.message;
}

/** The text of a message assistant-ui asks to send, such as a suggestion. */
function textOf(message: AppendMessage): string {
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}
