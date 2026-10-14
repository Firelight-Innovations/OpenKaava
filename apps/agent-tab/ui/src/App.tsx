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
  ConfigOption,
  Envelope,
  Harness,
  HarnessInfo,
  Hint,
  SessionStatus,
  SettingTrouble,
} from "./protocol.generated";
import { harnessChoices, type RunningModel } from "./harnesses";
import { latestUsage } from "./meters";
import {
  attached,
  busy,
  initialState,
  nextMode,
  place,
  unanswered,
  promptBefore,
  pickers,
  received,
  settable,
  type Choice,
  type Pending,
  type Setting,
  type TabState,
} from "./model";
import * as rpc from "./rpc";
import { toTurns, type Turn } from "./thread";
import { Turns, TurnsProvider } from "./Turns";
import { useSlots } from "./components/registry";
import type { PickerProps } from "./components/types";
import { hintText, infoOf, modelName } from "./harness";
import { strings, type HarnessWords } from "./strings";

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
  hint: string | null;
}

/** `words` is the harness the call went to, which a refusal's sentences name. */
function noticeOf(err: unknown, fallback: string, words: HarnessWords | undefined): Notice {
  const refusal = rpc.refusalOf(err);
  if (!refusal) return { text: fallback, hint: null };
  const text =
    refusal.code === "harness" && words
      ? strings.notReady(words.name)
      : (strings.refusal[refusal.code] ?? fallback);
  return { text, hint: refusal.hint && hintText(refusal.hint as Hint, words) };
}

export default function App() {
  const S = useSlots();
  const [state, dispatch] = useReducer(reduce, initialState);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  // The harness the next session starts in, as `agent-tab/harnesses` last said.
  const [chosen, setChosen] = useState<Harness | null>(null);
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
        setHarnesses(answer.harnesses);
        setChosen(answer.current);
      })
      .catch(() => {});
    return stop;
  }, [attach]);

  const status = state.status;
  const working = busy(status);
  const exited = status !== null && (status.state === "stopped" || status.state === "failed");
  // A tab runs its live agent's harness, and otherwise the one it chose; the
  // host resolves `agent-tab/send` the same way.
  const running = status && !exited ? status.harness : null;
  const current = infoOf(harnesses, running ?? chosen);
  // What the session's own hints and errors are about, even once it has ended.
  const session = infoOf(harnesses, status?.harness ?? null);

  const submit = useCallback(
    (text: string) => {
      if (text.trim() === "") return;
      setNotice(null);
      rpc.send(text).then(
        // Only if the box still holds what was sent: the user may have typed
        // on while it was in flight, and a Retry sends an older prompt.
        () => setDraft((now) => (now === text ? "" : now)),
        (err: unknown) => setNotice(noticeOf(err, strings.failed.send, current)),
      );
    },
    [current],
  );

  // The menu lists each harness's models, but the host takes only the harness
  // for now, and its default model with it.
  const chooseHarness = (harness: string) => {
    setNotice(null);
    rpc.choose(harness as Harness).then(
      () => setChosen(harness as Harness),
      (err: unknown) => setNotice(noticeOf(err, strings.failed.choose, current)),
    );
  };

  const stopTurn = useCallback(() => {
    void rpc.cancel().catch(() => {});
  }, []);

  const live = unanswered(pending, status);

  // Shown at once and held until the status that answers it; a refusal from
  // the host takes back that choice and no other. A later choice for the
  // same setting replaces this one, which the answers to this one then leave
  // alone.
  const choose = (setting: Setting, value: string, change: () => Promise<number>) => {
    if (status === null || !settable(status)) return;
    setNotice(null);
    const sent: Choice = { value, ticket: null };
    const settle = (next: Choice | undefined) =>
      setPending((p) => place(p, setting, (c) => (c === sent ? next : c)));
    setPending((p) => place(unanswered(p, status), setting, () => sent));
    change().then(
      (ticket) => settle({ ...sent, ticket }),
      (err: unknown) => {
        settle(undefined);
        setNotice(noticeOf(err, strings.failed.setting, session));
      },
    );
  };
  const onMode = (modeId: string) => choose("mode", modeId, () => rpc.setMode(modeId));
  const onConfig = (configId: string, value: string) =>
    choose({ option: configId }, value, () => rpc.setConfig(configId, value));

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && working) {
      event.preventDefault();
      stopTurn();
    } else if (event.key === "Tab" && event.shiftKey && status !== null && settable(status)) {
      // Only while there is a mode to switch to; otherwise Shift+Tab moves
      // focus back as usual. A held key keeps focus here but switches once,
      // not through every mode on the way round.
      const current = live?.mode?.value ?? status.mode;
      const next = nextMode(status.modes, current);
      if (next === null) return;
      event.preventDefault();
      if (!event.repeat) onMode(next);
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
            setNotice(noticeOf(err, strings.failed.send, session));
            throw err;
          },
        ),
      onRetry: (itemId: string) => {
        const text = promptBefore(state.items, itemId);
        if (text !== null) submit(text);
      },
      hintText: (hint: Hint) => hintText(hint, session),
    }),
    [state.items, submit, session],
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
  const trouble = status && settable(status) ? status.settingTrouble : null;
  const model = modelOption(status);
  // An ended session's model is not what the next prompt runs.
  const runningModel: RunningModel | null =
    running !== null && model
      ? { models: model.choices, model: live?.config[model.id]?.value ?? model.value }
      : null;
  // Only the harness in use can change model: picking another is not taken yet.
  const onModel =
    model && settable(status)
      ? (picked: string, value: string | null) => {
          if (picked === running && value !== null) onConfig(model.id, value);
        }
      : undefined;
  const pendingPrompt = typeof status?.pendingPrompt === "string" ? status.pendingPrompt : null;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TurnsProvider value={lookup}>
        <S.Layout
          header={
            <S.Header
              cwd={status?.cwd ?? null}
              harness={current?.name ?? null}
              // An ended session's model is not what the next prompt runs.
              model={running ? modelName(status) : null}
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
                  setupHint={current?.hint ? hintText(current.hint, current) : null}
                  onExample={(text) => {
                    setDraft(text);
                    prompt.current?.focus();
                  }}
                />
              ) : (
                <Turns />
              )}
              {pendingPrompt !== null && <S.UserMessage text={pendingPrompt} pending />}
              {hint && <S.Hint text={hintText(hint, session)} />}
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
                  {notice && <S.Notice text={notice.text} hint={notice.hint} action={null} />}
                </>
              }
              controls={
                <S.ModelMenu
                  label={strings.settings}
                  harness={running ?? chosen}
                  // The model is the running session's own option, so it is
                  // listed under the harness in use, with the agent's names.
                  harnesses={harnessChoices(harnesses, running ?? chosen, runningModel)}
                  // With no agent running, a pick chooses the next session's
                  // harness. While one runs, its prompts go to that agent until
                  // a new session starts, so only its model can change.
                  onChoose={running === null ? (harness) => chooseHarness(harness) : onModel}
                  sections={settingSections(status, live, onMode, onConfig)}
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

/** The session's model option, if the agent lists one. */
function modelOption(status: SessionStatus | null): ConfigOption | null {
  return (status && pickers(status).find((o) => o.category === "model")) ?? null;
}

/**
 * The settings menu's sections after the harnesses: the effort, then the
 * mode, with the agent's own names, in its order. The agent reports them only
 * once its session exists, and owner decision D2 starts that on the first
 * send, so until then the menu says when they will appear. A new model can
 * bring other effort levels, or none, so those come from each status as the
 * agent lists them. A choice is shown at once (`live`, see `unanswered` in
 * model.ts) and stands until the status that answers it.
 */
function settingSections(
  status: SessionStatus | null,
  live: Pending | null,
  onMode: (modeId: string) => void,
  onConfig: (configId: string, value: string) => void,
): PickerProps[] {
  const options = status ? pickers(status) : [];
  if (!status || (status.modes.length === 0 && options.length === 0)) {
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
  const disabled = !settable(status);
  const others: PickerProps[] = options
    .filter((option) => option.category !== "model")
    .map((option) => ({
      label: option.name || option.id,
      title: option.description,
      value: live?.config[option.id]?.value ?? option.value,
      choices: option.choices,
      disabled,
      onChange: (value: string) => onConfig(option.id, value),
    }));
  if (status.modes.length === 0) return others;
  return [
    ...others,
    {
      label: strings.mode,
      title: strings.modeSettings.modeHint,
      value: live?.mode?.value ?? status.mode,
      choices: status.modes,
      disabled,
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
