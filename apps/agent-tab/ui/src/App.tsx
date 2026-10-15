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
import type {
  Attachment,
  Envelope,
  HarnessInfo,
  Hint,
  SessionStatus,
  SettingTrouble,
} from "./protocol.generated";
import { harnessChoices } from "./harnesses";
import { latestUsage } from "./meters";
import {
  attached,
  busy,
  initialState,
  nextMode,
  unanswered,
  promptBefore,
  received,
  settable,
  type Pending,
  type TabState,
} from "./model";
import * as rpc from "./rpc";
import { toTurns, type Turn } from "./thread";
import { Turns, TurnsProvider } from "./Turns";
import { useSlots } from "./components/registry";
import type { PickerProps } from "./components/types";
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
  const [reported, setReported] = useState<HarnessInfo[]>([]);
  const [attachFailed, setAttachFailed] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
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
        setReported(answer.harnesses);
      })
      .catch(() => {});
    return stop;
  }, [attach]);

  const status = state.status;
  const working = busy(status);

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

  const live = unanswered(pending, status);

  // Shown at once and held until the status that answers it; a refusal from
  // the host takes it back.
  const choose = (change: () => Promise<number>, apply: (p: Pending) => Pending) => {
    if (!settable(status)) return;
    setNotice(null);
    setPending((p) => {
      const base = unanswered(p, status) ?? { ticket: 0, unnumbered: 0 };
      return apply({ ...base, unnumbered: base.unnumbered + 1 });
    });
    change().then(
      (ticket) =>
        setPending(
          (p) => p && { ...p, ticket: Math.max(p.ticket, ticket), unnumbered: p.unnumbered - 1 },
        ),
      (err: unknown) => {
        setPending(null);
        setNotice(noticeOf(err, strings.failed.setting));
      },
    );
  };
  const onMode = (modeId: string) =>
    choose(
      () => rpc.setMode(modeId),
      (p) => ({ ...p, mode: modeId }),
    );

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && working) {
      event.preventDefault();
      stopTurn();
    } else if (event.key === "Tab" && event.shiftKey && settable(status)) {
      // Only while there is a mode to switch to; otherwise Shift+Tab moves
      // focus back as usual.
      const current = live?.mode ?? status.mode;
      const next = nextMode(status.modes, current);
      if (next === null) return;
      event.preventDefault();
      onMode(next);
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

  const hint = status?.hint ?? null;
  // A session that has ended has nothing left to answer.
  const trouble = settable(status) ? status.settingTrouble : null;
  const pendingPrompt = typeof status?.pendingPrompt === "string" ? status.pendingPrompt : null;
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
              {state.items.length === 0 && pendingPrompt === null ? (
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
              {pendingPrompt !== null && <S.UserMessage text={pendingPrompt} pending />}
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
                  {trouble && <S.Notice text={troubleText(trouble)} hint={null} action={null} />}
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
                  harness={status?.harness ?? "claude"}
                  // No running model and no `onChoose` yet: the host does not
                  // report a session's models or take a harness choice on this
                  // branch, so the menu shows the harnesses and stays locked.
                  harnesses={harnessChoices(reported, status?.harness ?? "claude", null)}
                  sections={modeSection(status, live, onMode)}
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

/**
 * The session's mode, as the settings menu's section: the agent's own names,
 * in its order. The agent reports its modes only once its session exists, and
 * owner decision D2 starts that on the first send, so until then the section
 * says when they will appear. A choice is shown at once (`live`, see
 * `unanswered` in model.ts) and stands until the status that answers it.
 */
function modeSection(
  status: SessionStatus | null,
  live: Pending | null,
  onMode: (modeId: string) => void,
): PickerProps[] {
  if (!status || status.modes.length === 0) {
    // A session that ended before reporting any is not going to.
    const coming = !status || status.state === "starting";
    if (!coming) return [];
    return [
      {
        label: strings.mode,
        value: null,
        choices: [{ value: "", name: strings.modeSettings.later }],
      },
    ];
  }
  return [
    {
      label: strings.mode,
      title: strings.modeSettings.modeHint,
      value: live?.mode ?? status.mode,
      choices: status.modes,
      disabled: !settable(status),
      onChange: onMode,
    },
  ];
}

/**
 * A refused change, or one the agent is slow to answer, in words. It is said
 * above the prompt box rather than in the transcript, where an error would
 * offer to retry the last prompt.
 */
function troubleText(trouble: SettingTrouble): string {
  return trouble.kind === "refused"
    ? strings.modeSettings.refused(trouble.message)
    : strings.modeSettings.unanswered;
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
