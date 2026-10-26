/**
 * The props every slot takes: the whole contract between the tab's logic and
 * its look. A replacement component implements the same props and nothing
 * else. Everything here is plain data and callbacks; no slot is handed state,
 * an RPC or the transcript.
 */
import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from "react";
import type { ApprovalOption, PlanEntry, SessionState, ToolStatus } from "../protocol.generated";
import type { DiffLine } from "../diff";
import type { Tone } from "../meters";

/** The tab's frame: header on top, transcript in the middle, composer below. */
export interface LayoutProps {
  header: ReactNode;
  transcript: ReactNode;
  composer: ReactNode;
}

export interface HeaderProps {
  /** The session's state, or `null` before there is a session. */
  state: SessionState | null;
  onNewSession: () => void;
}

export interface StatusBadgeProps {
  state: SessionState | null;
}

/**
 * The scrolling list. Rendered inside assistant-ui's runtime, so a default may
 * use its thread primitives; it keeps the bottom in view while the agent works.
 */
export interface TranscriptProps {
  children: ReactNode;
}

/** One turn of the conversation; `children` is its items, already drawn. */
export interface TurnProps {
  children: ReactNode;
}

/** Shown in an agent turn that has nothing to show yet. */
export type WorkingProps = Record<string, never>;

/** Actions on a whole agent turn, such as copying it. */
export type TurnActionsProps = Record<string, never>;

export interface EmptyStateProps {
  /**
   * A refusal code for the whole cluster, or `null`. Unlike `setupHint` it stays
   * a code: the component words it itself, from `strings.refusal`.
   */
  blocked: string | null;
  /** What the harness still needs, already in words, or `null`. */
  setupHint: string | null;
}

export interface UserMessageProps {
  text: string;
  /** Accepted, but not sent yet: the agent is still starting. */
  pending?: boolean;
}

/** Sanitised HTML from `renderMarkdown`. The handlers copy code and stop links. */
export interface AssistantTextProps {
  html: string;
  onClick: (event: MouseEvent<HTMLDivElement>) => void;
  onAuxClick: (event: MouseEvent<HTMLDivElement>) => void;
}

/** A run of tool calls folded into one line; `children` are the calls' own rows. */
export interface ActionGroupProps {
  /**
   * Two or more calls, drawn as a line that opens. A lone call is passed with
   * `false` and should be drawn as it is, at the same place in the tree.
   */
  grouped: boolean;
  /** "Ran 2 commands, read a file". */
  summary: string;
  /** Some call has not finished: the line shimmers. */
  running: boolean;
  /** "1 failed", or `null` when none did. */
  failed: string | null;
  children: ReactNode;
}

export interface ThinkingProps {
  text: string;
  /** Still being written: the label shimmers. */
  live?: boolean;
}

/** One file's change, already diffed. `lines` is `null` when it is too large. */
export interface DiffProps {
  path: string;
  isNew: boolean;
  lines: DiffLine[] | null;
  added: number;
  removed: number;
}

export interface ToolCallProps {
  title: string;
  /** ACP's tool kind: `read`, `edit`, `execute`, `search`, ... */
  toolKind: string;
  status: ToolStatus;
  output: string;
  truncated: boolean;
  paths: string[];
  diffs: DiffProps[];
}

export interface PathListProps {
  paths: string[];
}

export interface ApprovalProps {
  title: string;
  detail: string | null;
  /** Only the start of `detail` is shown, so the person should not allow it blind. */
  detailTruncated: boolean;
  paths: string[];
  diffs: DiffProps[];
  options: ApprovalOption[];
  /** What was answered, in words, or `null` while it waits. */
  answer: string | null;
  /** The option being sent, while it is in flight; every option is disabled meanwhile. */
  sending: string | null;
  onChoose: (optionId: string) => void;
}

export interface TodoListProps {
  entries: PlanEntry[];
}

export interface UsageProps {
  used: number;
  size: number;
}

/** One part of what fills the context window: messages, tools, memory files. */
export interface ContextCategory {
  id: string;
  label: string;
  tokens: number;
}

/** The composer's context meter: the latest usage, or `null` before one arrives. */
export interface ContextMeterProps {
  used: number | null;
  size: number | null;
  /** What the used tokens are made of, when the agent says. Without it, one "Used" row. */
  categories?: ContextCategory[];
}

/** One usage limit of the plan the agent runs on, such as the session or the week. */
export interface UsageLimit {
  id: string;
  label: string;
  /** How much of it is used, 0 to 1. */
  share: number;
  /** When it resets, already in words ("Resets in 22 min"), or `null`. */
  resets: string | null;
}

/** The usage ring. With no limits it draws nothing. */
export interface UsageRingProps {
  limits: UsageLimit[];
}

/** A small button that shows a card while it is hovered or focused. */
export interface HoverCardProps {
  /** Names the button for assistive tech, with the figure it stands for. */
  label: string;
  /** What the button shows: a ring, a bar, a number. */
  trigger: ReactNode;
  /** Which edge of the button the card lines up with; `end` by default. */
  align?: "start" | "end";
  children: ReactNode;
}

/** A small progress ring. */
export interface RingProps {
  /** How full, 0 to 1. */
  share: number;
  tone: Tone;
}

/** A harness in the settings menu, with the models it offers. */
export interface HarnessChoice {
  /** `claude`, `codex`, `kaava`. */
  id: string;
  /** "Claude". */
  name: string;
  /** Its models, in the harness's order. Empty when they are not known yet. */
  models: PickerChoice[];
  /** The model it would run, or `null` for its own default. */
  model: string | null;
  /** Why it cannot be picked, in words ("Coming soon"), or `null`. */
  unavailable: string | null;
}

/** The composer's settings button: the harnesses and their models, then effort, mode and the rest. */
export interface ModelMenuProps {
  label: string;
  /** The harness in use, by id. */
  harness?: string | null;
  /**
   * Listed first, one group each, with its models under it: picking a model
   * picks its harness too. Leave out to list `sections` alone.
   */
  harnesses?: HarnessChoice[];
  /** Picks a harness and one of its models, `null` for its default. Without it the harnesses are shown but locked. */
  onChoose?: (harness: string, model: string | null) => void;
  /** The other settings, such as effort and mode, after the harnesses. */
  sections: PickerProps[];
}

export interface ErrorItemProps {
  message: string;
  /** The one-line fix, already in words, or `null`. */
  hint: string | null;
  onRetry: () => void;
}

/** A quiet line of text in the transcript, like "The agent stopped." */
export interface NoteProps {
  text: string;
}

/** A fix the user can make, in warning colours. */
export interface HintProps {
  text: string;
}

/** A refusal or failure above the composer, with an optional fix and action. */
export interface NoticeProps {
  text: string;
  hint: string | null;
  action: { label: string; onClick: () => void } | null;
}

export interface ComposerProps {
  ref: Ref<HTMLTextAreaElement>;
  value: string;
  placeholder: string;
  onChange: (text: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Notices to show above the input. */
  notices: ReactNode;
  /** The slash-command list, floated above the box while one is being typed. */
  menu?: ReactNode;
  /** The id of the menu item Enter and Tab would pick, for the input to point at. */
  menuActiveId?: string | null;
  /** Under the box, at the left: the settings button. */
  controls: ReactNode;
  /** Under the box, at the right: the context meter and the usage ring. */
  meters: ReactNode;
  /** Inside the box, at the end of the input: Send or Stop. */
  action: ReactNode;
}

export interface SendButtonProps {
  disabled: boolean;
  onClick: () => void;
}

export interface StopButtonProps {
  onClick: () => void;
}

export interface PickerChoice {
  value: string;
  name: string;
  description?: string | null;
}

/**
 * A setting with a few choices: mode, model, effort, harness, or any other
 * option the agent reports. Without `onChange` it is shown, not chosen.
 */
export interface PickerProps {
  label: string;
  title?: string | null;
  value: string | null;
  choices: PickerChoice[];
  disabled?: boolean;
  onChange?: (value: string) => void;
}

export interface MenuItem {
  id: string;
  label: string;
  /** A second line or hint, such as a command's argument or a file's folder. */
  detail?: string;
}

/** A popup list under the caret: slash commands, @ mentions. */
export interface MenuProps {
  label: string;
  items: MenuItem[];
  activeId: string | null;
  onPick: (id: string) => void;
}

export interface SessionRow {
  id: string;
  title: string;
  state: SessionState | null;
  /** When it was last active, already formatted for display. */
  when: string;
}

export interface SessionListProps {
  sessions: SessionRow[];
  activeId: string | null;
  onOpen: (id: string) => void;
}
