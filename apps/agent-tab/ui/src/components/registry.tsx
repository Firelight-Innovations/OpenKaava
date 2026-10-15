/**
 * The agent tab's slot map: every visual piece, by name. Swap a piece by
 * pointing its name at another component with the same props (`types.ts`).
 * The logic (`App.tsx`, `Items.tsx`) renders only through `useSlots()`, so this
 * object is the one place that decides what the tab looks like.
 *
 * `SlotsProvider` overrides some or all of it at runtime, for a test or a
 * component set being tried out. See `README.md` beside this file.
 */
import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";
import { Approval } from "./Approval";
import { AssistantTurn } from "./AssistantTurn";
import { AssistantText } from "./AssistantText";
import { Composer } from "./Composer";
import { ContextMeter } from "./ContextMeter";
import { Diff } from "./Diff";
import { EmptyState } from "./EmptyState";
import { ErrorItem } from "./ErrorItem";
import { Header } from "./Header";
import { Hint } from "./Hint";
import { Layout } from "./Layout";
import { Menu } from "./Menu";
import { Note } from "./Note";
import { Notice } from "./Notice";
import { PathList } from "./PathList";
import { Picker } from "./Picker";
import { SendButton } from "./SendButton";
import { SessionList } from "./SessionList";
import { StatusBadge } from "./StatusBadge";
import { StopButton } from "./StopButton";
import { Thinking } from "./Thinking";
import { TodoList } from "./TodoList";
import { ToolCall } from "./ToolCall";
import { Transcript } from "./Transcript";
import { TurnActions } from "./TurnActions";
import { Usage } from "./Usage";
import { UserMessage } from "./UserMessage";
import { UserTurn } from "./UserTurn";
import { Working } from "./Working";
import type * as P from "./types";

export interface Slots {
  // Frame
  Layout: ComponentType<P.LayoutProps>;
  Header: ComponentType<P.HeaderProps>;
  StatusBadge: ComponentType<P.StatusBadgeProps>;
  Transcript: ComponentType<P.TranscriptProps>;
  EmptyState: ComponentType<P.EmptyStateProps>;
  SessionList: ComponentType<P.SessionListProps>;
  // Turns
  UserTurn: ComponentType<P.TurnProps>;
  AssistantTurn: ComponentType<P.TurnProps>;
  TurnActions: ComponentType<P.TurnActionsProps>;
  Working: ComponentType<P.WorkingProps>;
  // Transcript items
  UserMessage: ComponentType<P.UserMessageProps>;
  AssistantText: ComponentType<P.AssistantTextProps>;
  Thinking: ComponentType<P.ThinkingProps>;
  ToolCall: ComponentType<P.ToolCallProps>;
  Diff: ComponentType<P.DiffProps>;
  PathList: ComponentType<P.PathListProps>;
  Approval: ComponentType<P.ApprovalProps>;
  TodoList: ComponentType<P.TodoListProps>;
  Usage: ComponentType<P.UsageProps>;
  ErrorItem: ComponentType<P.ErrorItemProps>;
  Note: ComponentType<P.NoteProps>;
  Hint: ComponentType<P.HintProps>;
  // Composer
  Composer: ComponentType<P.ComposerProps>;
  Notice: ComponentType<P.NoticeProps>;
  SendButton: ComponentType<P.SendButtonProps>;
  StopButton: ComponentType<P.StopButtonProps>;
  ContextMeter: ComponentType<P.ContextMeterProps>;
  ModePicker: ComponentType<P.PickerProps>;
  ModelPicker: ComponentType<P.PickerProps>;
  EffortPicker: ComponentType<P.PickerProps>;
  HarnessPicker: ComponentType<P.PickerProps>;
  /** Any other option the agent reports, such as fast mode. */
  OptionPicker: ComponentType<P.PickerProps>;
  // Menus
  SlashMenu: ComponentType<P.MenuProps>;
  MentionMenu: ComponentType<P.MenuProps>;
}

/** The one mapping. Change a line here to swap that piece everywhere. */
export const defaultSlots: Slots = {
  Layout,
  Header,
  StatusBadge,
  Transcript,
  EmptyState,
  SessionList,
  UserTurn,
  AssistantTurn,
  TurnActions,
  Working,
  UserMessage,
  AssistantText,
  Thinking,
  ToolCall,
  Diff,
  PathList,
  Approval,
  TodoList,
  Usage,
  ErrorItem,
  Note,
  Hint,
  Composer,
  Notice,
  SendButton,
  StopButton,
  ContextMeter,
  ModePicker: Picker,
  ModelPicker: Picker,
  EffortPicker: Picker,
  HarnessPicker: Picker,
  OptionPicker: Picker,
  SlashMenu: Menu,
  MentionMenu: Menu,
};

const SlotsContext = createContext<Slots>(defaultSlots);

/** The slots in effect here: the defaults, with any provider's overrides. */
export function useSlots(): Slots {
  return useContext(SlotsContext);
}

/** Overrides some slots for everything inside it; the rest stay as they are. */
export function SlotsProvider({ slots, children }: { slots: Partial<Slots>; children: ReactNode }) {
  const outer = useSlots();
  const merged = useMemo(() => ({ ...outer, ...slots }), [outer, slots]);
  return <SlotsContext.Provider value={merged}>{children}</SlotsContext.Provider>;
}
