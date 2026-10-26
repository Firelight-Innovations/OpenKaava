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
import { completion, isLogin, matching, offered, skillCommands, commandSupport } from "./commands";
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
import type { PickerProps, MenuItem } from "./components/types";
import { hintText, infoOf } from "./harness";
import { strings, type HarnessWords } from "./strings";
import { withChips, type ContextChip } from "./mentions";
import { useMentions } from "./useMentions";
import { useSideChat } from "./useSideChat";
import { EFFORT_LEVELS } from "./preferences";

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
  const [harnessesFailed, setHarnessesFailed] = useState(false);
  // The slash-command list: the row the keys are on, and the draft Esc closed it for.
  const [menuRow, setMenuRow] = useState(0);
  const [menuPath, setMenuPath] = useState<string[]>([]);
  const [menuClosedFor, setMenuClosedFor] = useState<string | null>(null);
  // What `/login` last said, shown under the transcript until the next prompt.
  const [loginNote, setLoginNote] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [ultracode, setUltracode] = useState(false);
  const [settingsRequest, setSettingsRequest] = useState(0);
  const [caret, setCaret] = useState(0);
  const [chips, setChips] = useState<ContextChip[]>([]);
  const [previewEffort, setPreviewEffort] = useState<string | null>(null);
  const [sources, setSources] = useState<Awaited<ReturnType<typeof rpc.contextSources>>>({
    clusters: [],
    issues: [],
  });
  const [contextScope, setContextScope] = useState<string | null>(null);
  const mentions = useMentions(draft, caret, contextScope);
  const [issuePicker, setIssuePicker] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [savedSessions, setSavedSessions] = useState<rpc.SavedSession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const side = useSideChat(state.items);
  const askSide = side.ask;
  // Counts the choices this tab has heard of. A `harnesses` reply asked for
  // before one is older than it, so it must not put back the harness it
  // replaced.
  const choices = useRef(0);
  const prompt = useRef<HTMLTextAreaElement | null>(null);
  const loadHistory = useCallback(() => {
    setHistoryLoading(true);
    setHistoryError(null);
    void rpc
      .history()
      .then(
        (answer) => setSavedSessions(answer.sessions ?? []),
        () => setHistoryError(strings.history.failed),
      )
      .finally(() => setHistoryLoading(false));
  }, []);
  useEffect(() => {
    if (!state.attached || (!state.items.length && !state.status?.pendingPrompt)) return;
    const timer = setTimeout(() => {
      void rpc.saveHistory().catch(() => {});
    }, 750);
    return () => clearTimeout(timer);
  }, [state.attached, state.items, state.status?.pendingPrompt]);
  // The effect that hears a sign-in end runs once, so it reads the latest list from here.
  const harnessesRef = useRef<HarnessInfo[]>([]);
  harnessesRef.current = harnesses;

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

  const heardChoice = useCallback((harness: Harness) => {
    choices.current += 1;
    setChosen(harness);
  }, []);

  // Without this answer the tab has no harness to name or offer, so a failure
  // says so and can be retried.
  const listHarnesses = useCallback(() => {
    const asked = choices.current;
    return rpc.harnesses().then(
      (answer) => {
        setHarnessesFailed(false);
        setBlocked(answer.blocked);
        setHarnesses(answer.harnesses);
        if (choices.current === asked) setChosen(answer.current);
      },
      () => setHarnessesFailed(true),
    );
  }, []);

  useEffect(() => {
    const stop = rpc.onEnvelope((envelope) => dispatch({ type: "envelope", envelope }));
    const stopChosen = rpc.onChosen(heardChoice);
    void attach().finally(() => reportPainted());
    void listHarnesses();
    void rpc.contextSources().then(
      (answer) => setSources({ clusters: answer?.clusters ?? [], issues: answer?.issues ?? [] }),
      () => {},
    );
    // The host asks each agent for its models after its first answer, and
    // says when they are in.
    const stopModels = rpc.onModels(() => void listHarnesses());
    const stopLogin = rpc.onLogin((harness, ok) => {
      const name = infoOf(harnessesRef.current, harness)?.name ?? "";
      setLoginNote(ok ? strings.login.done(name) : strings.login.failed(name));
      if (ok) void listHarnesses();
    });
    return () => {
      stop();
      stopChosen();
      stopModels();
      stopLogin();
    };
  }, [attach, heardChoice, listHarnesses]);

  const status = state.status;
  const working = busy(status);
  const exited = status !== null && (status.state === "stopped" || status.state === "failed");
  // A tab runs its live agent's harness, and otherwise the one it chose; the
  // host resolves `agent-tab/send` the same way.
  const running = status && !exited ? status.harness : null;
  const current = infoOf(harnesses, running ?? chosen);
  // What the session's own hints are about, even once it has ended. An error
  // item names its own harness, which an earlier session may have run.
  const session = infoOf(harnesses, status?.harness ?? null);
  const reportedCommands = useMemo(
    () =>
      status?.harness === (running ?? chosen) && status.commands.length
        ? status.commands
        : (current?.commands ?? []),
    [status?.harness, status?.commands, current?.commands, running, chosen],
  );
  const skillList = skillCommands(reportedCommands, running ?? chosen ?? "claude");

  const submit = useCallback(
    (text: string, retry = false) => {
      if (text.trim() === "" && (retry || chips.length === 0)) return;
      setNotice(null);
      if (/^\/skills(?:\s|$)/.test(text.trim())) {
        setDraft("/skills ");
        setMenuClosedFor(null);
        return;
      }
      if (commandSupport(text, reportedCommands, running ?? chosen ?? "claude") === "terminal") {
        void rpc.cliCommand(text).then(
          () => {
            setDraft("");
            setLoginNote(strings.openedTerminal(current?.name ?? ""));
          },
          (err: unknown) => setNotice(noticeOf(err, strings.failed.send, current)),
        );
        return;
      }
      const [command, ...args] = text.trim().split(/\s+/);
      if (
        ["/model", "/effort", "/clear", "/new", "/reset", "/stop", "/help", "/btw"].includes(
          command,
        )
      ) {
        setDraft("");
        if (["/clear", "/new", "/reset"].includes(command))
          void rpc
            .reset()
            .catch((err: unknown) => setNotice(noticeOf(err, strings.failed.setting, current)));
        else if (command === "/stop") void rpc.cancel().catch(() => {});
        else if (command === "/help") setLoginNote(strings.help);
        else if (command === "/btw") askSide(args.join(" "));
        else if (
          command === "/effort" &&
          args[0] === "ultracode" &&
          current?.harness === "claude"
        ) {
          if (running)
            void rpc
              .setConfig("ultra_effort", args[1] === "off" ? "off" : "on")
              .catch((err: unknown) => setNotice(noticeOf(err, strings.failed.setting, current)));
          else setUltracode(args[1] !== "off");
        } else if (command === "/effort" && args.length) {
          const option = status?.config.find((c) => c.category === "thought_level");
          const value = args[0].toLowerCase();
          if (option?.choices.some((c) => c.value === value))
            void rpc
              .setConfig(option.id, value)
              .catch((err: unknown) => setNotice(noticeOf(err, strings.failed.setting, current)));
          else if (!status && EFFORT_LEVELS.some((v) => v === value)) setEffort(value);
          else setLoginNote(strings.preferences.unsupported);
        } else setSettingsRequest((n) => n + 1);
        return;
      }
      // The sign-in is the host's, not a prompt: the agent never sees it.
      if (isLogin(text)) {
        setDraft("");
        setLoginNote(strings.login.started(current?.name ?? ""));
        rpc.login().catch((err: unknown) => {
          setLoginNote(null);
          setNotice(noticeOf(err, strings.login.notStarted, current));
        });
        return;
      }
      setLoginNote(null);
      const sentChips = retry ? [] : chips;
      rpc
        .send(
          withChips(text, sentChips),
          effort !== null || (ultracode && current?.harness === "claude")
            ? { effort, ultracode: ultracode && current?.harness === "claude" }
            : undefined,
        )
        .then(
          // Only if the box still holds what was sent: the user may have typed
          // on while it was in flight, and a Retry sends an older prompt.
          () => {
            setDraft((now) => (now === text ? "" : now));
            setChips((now) => now.filter((c) => !sentChips.includes(c)));
          },
          (err: unknown) => setNotice(noticeOf(err, strings.failed.send, current)),
        );
    },
    [current, effort, ultracode, status, askSide, chips, reportedCommands, running, chosen],
  );

  // A harness and one of its models, `null` for the agent's default. The host
  // keeps the model for that harness's next session, and the menu checks it
  // once the harnesses are listed again.
  const chooseHarness = (harness: string, model: string | null) => {
    setNotice(null);
    rpc.choose(harness as Harness, model).then(
      () => {
        heardChoice(harness as Harness);
        void attach();
        void listHarnesses();
      },
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

  const skillsOpen = /^\/skills(?:\s|$)/.test(draft);
  const skillQuery = draft.replace(/^\/skills\s*/, "").toLowerCase();
  const matches = skillsOpen
    ? skillList
        .filter((s) => s.name.toLowerCase().includes(skillQuery))
        .map((s) => ({ ...s, support: "agent" as const }))
    : matching(draft, offered(reportedCommands, running ?? chosen ?? "claude"));
  const mentionOpen = mentions.query !== null && menuClosedFor !== draft;
  const menuOpen = !mentionOpen && matches.length > 0 && menuClosedFor !== draft;
  const pickCommand = (name: string) => {
    if (name.startsWith("skill:")) {
      const skill = skillList.find((s) => s.name === name.slice(6));
      if (skill) {
        setChips((now) =>
          now.some((c) => c.id === name)
            ? now
            : [
                ...now,
                {
                  id: name,
                  label: skill.name.replace(/^\$/, ""),
                  kind: "skill",
                  command: skill.name,
                },
              ],
        );
        setDraft("");
        prompt.current?.focus();
      }
      return;
    }
    if (skillsOpen) {
      pickCommand(`skill:${name}`);
      return;
    }
    const command = matches.find((c) => c.name === name);
    if (command) setDraft(completion(command));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Backspace" && draft === "" && chips.length) {
      event.preventDefault();
      setChips((now) => now.slice(0, -1));
      return;
    }
    if ((mentionOpen || menuOpen) && !event.nativeEvent.isComposing) {
      const count = navigable.length;
      const picked = navigable[Math.min(menuRow, count - 1)];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        if (count) setMenuRow((Math.min(menuRow, count - 1) + step + count) % count);
        return;
      }
      if (event.key === "Escape" || (event.key === "ArrowLeft" && menuPath.length)) {
        event.preventDefault();
        if (menuPath.length) {
          setMenuPath(menuPath.slice(0, -1));
          setMenuRow(0);
        } else setMenuClosedFor(draft);
        return;
      }
      // A command typed out in full, with no argument to give, sends as it is.
      const complete =
        menuOpen &&
        !skillsOpen &&
        !menuPath.length &&
        !picked?.children &&
        matches.some((c) => c.name === picked?.id && draft === `/${c.name}` && c.hint === null);
      if (
        picked &&
        ((event.key === "Tab" && !event.shiftKey) ||
          (event.key === "ArrowRight" && picked.children) ||
          (event.key === "Enter" && !event.shiftKey && !complete))
      ) {
        event.preventDefault();
        if (picked.children) {
          setMenuPath([...menuPath, picked.id]);
          setMenuRow(0);
        } else {
          if (mentionOpen) pickMention(picked.id);
          else pickCommand(picked.id);
          setMenuPath([]);
          setMenuRow(0);
        }
        return;
      }
    }
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
      if (!working || /^\/(btw|model|effort|login|clear|new|reset|stop|help)(?:\s|$)/.test(draft))
        submit(draft);
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
        if (text !== null) submit(text, true);
      },
      hintText: (hint: Hint, harness: Harness) => hintText(hint, infoOf(harnesses, harness)),
    }),
    [state.items, submit, session, harnesses],
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
  const pickMention = (uri: string) => {
    if (uri.startsWith("scope:")) {
      setContextScope(uri.slice(6));
      setLoginNote(strings.searchInScope);
      return;
    }
    if (uri.startsWith("cluster:")) {
      void rpc.clusterContext(uri.slice(8)).then(
        (hit) => {
          setChips((now) =>
            now.some((c) => c.id === hit.uri)
              ? now
              : [...now, { id: hit.uri, label: hit.title, kind: hit.kind, uri: hit.uri }],
          );
          if (mentions.query) {
            setDraft(draft.slice(0, mentions.query.start) + draft.slice(mentions.query.end));
            setCaret(mentions.query.start);
          }
        },
        () => setLoginNote(strings.mentions.failed),
      );
      return;
    }
    if (uri === "issue:link") {
      setIssuePicker(true);
      setMenuClosedFor(draft);
      return;
    }
    const hit = [...mentions.items, ...sources.issues].find((h) => h.uri === uri);
    if (!hit || !mentions.query) return;
    setLoginNote(null);
    setChips((now) =>
      now.some((c) => c.id === hit.uri)
        ? now
        : [...now, { id: hit.uri, label: hit.title, kind: hit.kind, uri: hit.uri }],
    );
    const next = {
      text: draft.slice(0, mentions.query.start) + draft.slice(mentions.query.end),
      caret: mentions.query.start,
    };
    setDraft(next.text);
    setCaret(next.caret);
    setMenuRow(0);
    requestAnimationFrame(() => {
      prompt.current?.focus();
      prompt.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  const sections = settingSections(status, live, onMode, onConfig);
  if (!running)
    sections.unshift({
      label: strings.preferences.effort,
      value: effort,
      choices: EFFORT_LEVELS.map((value, i) => ({ value, name: strings.preferences.levels[i] })),
      onChange: setEffort,
    });
  for (const section of sections)
    if (section.label === strings.preferences.effort) {
      section.choices = section.choices.filter((c) => c.value !== "ultra");
      section.onPreview = setPreviewEffort;
    }
  const workflow =
    live?.config.ultra_effort?.value ?? status?.config.find((o) => o.id === "ultra_effort")?.value;
  const ultraEnabled =
    (running ?? chosen) === "claude" && (running ? workflow === "on" : ultracode);
  const effortValue = ultraEnabled
    ? "ultra"
    : (sections.find((s) => s.label === strings.preferences.effort)?.value ?? "medium");
  const contextItem = (h: (typeof mentions.items)[number]): MenuItem => ({
    id: h.uri,
    label: h.title,
    detail: h.detail ?? h.kind,
  });
  const empty = (label: string): MenuItem[] => [{ id: `empty:${label}`, label, disabled: true }];
  const byKind = (kinds: string[]) =>
    mentions.items.filter((h) => kinds.includes(h.kind)).map(contextItem);
  const group = (id: string, label: string, children: MenuItem[]): MenuItem => ({
    id,
    label,
    children: children.length ? children : empty(strings.mentions.empty),
  });
  const contextItems: MenuItem[] =
    mentions.query?.query || contextScope
      ? mentions.items.map(contextItem)
      : [
          group("design", strings.contextGroups.design, [
            group("canvases", strings.contextGroups.canvases, [
              ...byKind(["canvas"]),
              { id: "scope:canvas", label: strings.searchCanvases },
            ]),
            group("frames", strings.contextGroups.frames, [
              ...byKind(["frame"]),
              { id: "scope:frame", label: strings.searchFrames },
            ]),
            group("design-comments", strings.contextGroups.comments, [
              ...byKind(["design-comment", "comment"]),
              { id: "scope:design-comment", label: strings.searchComments },
            ]),
          ]),
          group("pm", strings.contextGroups.pm, [
            group("jira", "Jira", [
              ...sources.issues
                .filter((h) => /jira/i.test(`${h.title} ${h.detail}`))
                .map(contextItem),
              { id: "issue:link", label: strings.issueLink },
            ]),
            group("linear", "Linear", [
              ...sources.issues
                .filter((h) => /linear/i.test(`${h.title} ${h.detail}`))
                .map(contextItem),
              { id: "issue:link", label: strings.issueLink },
            ]),
          ]),
          group(
            "clusters",
            strings.contextGroups.clusters,
            sources.clusters.map((c) => ({ id: `cluster:${c.id}`, label: c.title })),
          ),
          group("files", strings.contextGroups.files, [
            ...byKind(["file", "folder"]),
            { id: "scope:file", label: strings.searchFiles },
          ]),
          group("comments", strings.contextGroups.comments, [
            ...byKind(["comment", "design-comment"]),
            { id: "scope:comment", label: strings.searchComments },
          ]),
          group("context", strings.contextGroups.context, [
            ...byKind(["context"]),
            { id: "scope:context", label: strings.searchSaved },
          ]),
          ...byKind(["selection"]),
        ];
  const skillItems = skillList.map((s) => ({
    id: `skill:${s.name}`,
    label: s.name.replace(/^\$/, ""),
    detail: s.description,
  }));
  const slashItems: MenuItem[] = matches.map((c) => ({
    id: skillsOpen ? `skill:${c.name}` : c.name,
    label: c.name,
    detail: `${c.description}${c.support === "terminal" ? ` · ${strings.inTerminal}` : ""}`,
    children:
      c.name === "skills"
        ? skillItems.length
          ? skillItems
          : empty(strings.skills.empty)
        : undefined,
  }));
  let visibleItems = mentionOpen ? contextItems : slashItems;
  for (const id of menuPath) {
    const children = visibleItems.find((i) => i.id === id)?.children;
    if (!children) break;
    visibleItems = children;
  }
  const navigable = visibleItems.filter((i) => !i.disabled);
  const menuActive = navigable[Math.min(menuRow, navigable.length - 1)]?.id ?? null;
  const changeMenuPath = (path: string[]) => {
    setMenuPath(path);
    setMenuRow(0);
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TurnsProvider value={lookup}>
        <S.Layout
          header={
            <S.Header
              state={status?.state ?? null}
              onSideChat={() => askSide("")}
              onHistory={() => {
                setHistoryOpen((was) => !was);
                if (!historyOpen) loadHistory();
              }}
              history={
                historyOpen ? (
                  <S.HistoryPanel
                    sessions={savedSessions}
                    loading={historyLoading}
                    error={historyError}
                    onClose={() => {
                      setHistoryOpen(false);
                      prompt.current?.focus();
                    }}
                    onRetry={loadHistory}
                    onArchive={(id, archived) => {
                      void rpc
                        .archiveHistory(id, archived)
                        .then(loadHistory, () => setHistoryError(strings.history.failed));
                    }}
                    onOpen={(id, harness) => {
                      setHistoryLoading(true);
                      setPending(null);
                      void rpc
                        .openHistory(id, harness)
                        .then(
                          (attachment) => {
                            dispatch({ type: "attached", attachment });
                            setHistoryOpen(false);
                            setNotice(null);
                            setDraft("");
                            setChips([]);
                            void listHarnesses();
                          },
                          () => setHistoryError(strings.history.openFailed),
                        )
                        .finally(() => setHistoryLoading(false));
                    }}
                  />
                ) : undefined
              }
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
                />
              ) : (
                <Turns />
              )}
              {pendingPrompt !== null && <S.UserMessage text={pendingPrompt} pending />}
              {hint && <S.Hint text={hintText(hint, session)} />}
              {loginNote && <S.Note text={loginNote} />}
              {exited && state.items.length > 0 && (
                <S.Note text={strings.exited(status.exitCode)} />
              )}
            </S.Transcript>
          }
          composer={
            <S.Composer
              ref={prompt}
              chips={chips}
              onRemoveChip={(id) => setChips((now) => now.filter((c) => c.id !== id))}
              effortLevel={previewEffort ?? effortValue}
              auxiliary={
                issuePicker ? (
                  <S.ContextLink
                    onCancel={() => setIssuePicker(false)}
                    onAdd={(link) => {
                      setChips((now) => [
                        ...now.filter((c) => c.id !== link),
                        {
                          id: link,
                          label: link.split("/").filter(Boolean).slice(-2).join("/"),
                          kind: "issue",
                          uri: link,
                        },
                      ]);
                      setIssuePicker(false);
                      if (mentions.query) {
                        setDraft(
                          draft.slice(0, mentions.query.start) + draft.slice(mentions.query.end),
                        );
                        setCaret(mentions.query.start);
                      }
                    }}
                  />
                ) : undefined
              }
              value={draft}
              placeholder={working ? strings.promptBusy : strings.promptPlaceholder}
              onChange={(text) => {
                setDraft(text);
                if (!text.includes("@")) setContextScope(null);
                setCaret(text.length);
                setMenuRow(0);
                setMenuPath([]);
              }}
              onSelect={setCaret}
              onAttach={() => {
                const at = prompt.current?.selectionStart ?? draft.length;
                const prefix = at > 0 && !/\s/.test(draft[at - 1]) ? " @" : "@";
                const next = draft.slice(0, at) + prefix + draft.slice(at);
                setDraft(next);
                setCaret(at + prefix.length);
                setMenuRow(0);
                setMenuClosedFor(null);
                requestAnimationFrame(() => {
                  prompt.current?.focus();
                  prompt.current?.setSelectionRange(at + prefix.length, at + prefix.length);
                });
              }}
              onDictate={() => {}}
              contextNotice={mentionOpen ? mentions.note : null}
              sideChat={side.open ? <S.SideChat {...side.props} /> : undefined}
              onKeyDown={onKeyDown}
              menu={
                mentionOpen ? (
                  <S.MentionMenu
                    label={strings.mentions.label}
                    items={contextItems}
                    activeId={menuActive}
                    path={menuPath}
                    onPathChange={changeMenuPath}
                    onPick={pickMention}
                  />
                ) : (
                  menuOpen && (
                    <S.SlashMenu
                      label={strings.commands}
                      items={slashItems}
                      activeId={menuActive}
                      path={menuPath}
                      onPathChange={changeMenuPath}
                      onPick={pickCommand}
                    />
                  )
                )
              }
              menuActiveId={mentionOpen || menuOpen ? menuActive : null}
              notices={
                <>
                  {attachFailed && (
                    <S.Notice
                      text={strings.failed.attach}
                      hint={null}
                      action={{ label: strings.retry, onClick: () => void attach() }}
                    />
                  )}
                  {harnessesFailed && (
                    <S.Notice
                      text={strings.failed.harnesses}
                      hint={null}
                      action={{ label: strings.retry, onClick: () => void listHarnesses() }}
                    />
                  )}
                  {trouble && <S.Notice text={troubleText(trouble)} hint={null} action={null} />}
                  {notice && <S.Notice text={notice.text} hint={notice.hint} action={null} />}
                </>
              }
              controls={
                <S.ModelMenu
                  label={strings.settings}
                  openRequest={settingsRequest}
                  harnessLocked={false}
                  ultracode={{
                    enabled: ultraEnabled,
                    disabled: status?.state === "starting",
                    onChange: (enabled) => {
                      if (running) onConfig("ultra_effort", enabled ? "on" : "off");
                      else setUltracode(enabled);
                    },
                  }}
                  harness={running ?? chosen}
                  // The model is the running session's own option, so it is
                  // listed under the harness in use, with the agent's names.
                  harnesses={harnessChoices(harnesses, running ?? chosen, runningModel)}
                  // With no agent running, a pick chooses the next session's
                  // harness. While one runs, its prompts go to that agent until
                  // a new session starts, so only its model can change.
                  onChoose={(picked, value) => {
                    if (picked === running && onModel) onModel(picked, value);
                    else chooseHarness(picked, value);
                  }}
                  sections={sections}
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
                  <S.SendButton
                    disabled={draft.trim() === "" && chips.length === 0}
                    onClick={() => submit(draft)}
                  />
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
  if (!status) {
    return [
      {
        label: strings.mode,
        value: null,
        choices: [{ value: "", name: strings.modeSettings.later }],
        disabled: true,
      },
    ];
  }
  if (status.modes.length === 0 && options.length === 0) return [];
  const disabled = !settable(status);
  const others: PickerProps[] = options
    .filter((option) => option.category !== "model" && option.id !== "ultra_effort")
    .map((option) => ({
      label:
        option.category === "thought_level" ? strings.preferences.effort : option.name || option.id,
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
