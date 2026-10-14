/**
 * The props every slot takes: the whole contract between the tab's logic and
 * its look. A replacement component implements the same props and nothing
 * else. Everything here is plain data and callbacks; no slot is handed state,
 * an RPC or the transcript.
 */
import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from "react";
import type { ApprovalOption, PlanEntry, SessionState, ToolStatus } from "../protocol.generated";
import type { DiffLine } from "../diff";

/** The tab's frame: header on top, transcript in the middle, composer below. */
export interface LayoutProps {
  header: ReactNode;
  transcript: ReactNode;
  composer: ReactNode;
}

export interface HeaderProps {
  /** The worktree the session runs in, or `null` before there is a session. */
  cwd: string | null;
  /** The harness's display name ("Claude"), or `null` before the tab has heard. */
  harness: string | null;
  /** The running model's name, or `null` when it is not known. */
  model: string | null;
  state: SessionState | null;
  onNewSession: () => void;
}

export interface StatusBadgeProps {
  state: SessionState | null;
}

/** The scrolling list. `ref` and `onScroll` drive follow-the-bottom. */
export interface TranscriptProps {
  ref: Ref<HTMLDivElement>;
  onScroll: () => void;
  children: ReactNode;
}

export interface EmptyStateProps {
  /** A refusal code for the whole cluster, or `null`. */
  blocked: string | null;
  /** What the harness still needs, already in words, or `null`. */
  setupHint: string | null;
  onExample: (text: string) => void;
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

export interface ThinkingProps {
  text: string;
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

/** The composer's context meter: the latest usage, or `null` before one arrives. */
export interface ContextMeterProps {
  used: number | null;
  size: number | null;
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
  /** The footer's left side: mode, model, effort and harness pickers. */
  controls: ReactNode;
  /** The footer's right side: Send or Stop. */
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
