/**
 * The agent bar's default look, one component per slot in `slots.tsx`. Plain
 * data and callbacks in; the sending, the draft and the autosize live in
 * `AgentBar.tsx`.
 */
import type { KeyboardEvent, ReactNode, Ref } from "react";
import { strings } from "./strings";

export interface BarFrameProps {
  notice: ReactNode;
  harness: ReactNode;
  input: ReactNode;
  action: ReactNode;
}

export function BarFrame({ notice, harness, input, action }: BarFrameProps) {
  return (
    <section className="agentbar" aria-label={strings.label}>
      {notice}
      <div className="agentbar__row">
        {harness}
        {input}
        {action}
      </div>
    </section>
  );
}

export interface BarNoticeProps {
  text: string;
}

export function BarNotice({ text }: BarNoticeProps) {
  return (
    <div className="agentbar__notice" role="status">
      {text}
    </div>
  );
}

export interface BarHarnessChoice {
  value: string;
  name: string;
  /** What this harness still needs, already in words, or `null`. */
  description: string | null;
}

export interface BarHarnessProps {
  /** The name of the harness the next prompt goes to, or `null` before the bar has heard. */
  name: string | null;
  /** The running model's name, or `null` when it is not known. */
  model: string | null;
  value: string | null;
  choices: BarHarnessChoice[];
  /** While the tab's agent runs: its prompts go there until a new session. */
  disabled: boolean;
  onChange: (harness: string) => void;
}

/** The harness the bar sends to: its name, or a picker once there is more than one. */
export function BarHarness({ name, model, value, choices, disabled, onChange }: BarHarnessProps) {
  return (
    <>
      {choices.length > 1 ? (
        <select
          className="agentbar__harness"
          aria-label={strings.harnessLabel}
          title={disabled ? strings.harnessLocked : undefined}
          value={value ?? ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value} title={choice.description ?? undefined}>
              {choice.name}
            </option>
          ))}
        </select>
      ) : (
        name !== null && <span className="agentbar__harness">{name}</span>
      )}
      {model !== null && (
        <span className="agentbar__harness agentbar__model" title={model}>
          {model}
        </span>
      )}
    </>
  );
}

export interface BarInputProps {
  ref: Ref<HTMLTextAreaElement>;
  value: string;
  disabled: boolean;
  onChange: (text: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

export function BarInput({ ref, value, disabled, onChange, onKeyDown }: BarInputProps) {
  return (
    <textarea
      ref={ref}
      className="agentbar__input"
      aria-label={strings.promptLabel}
      placeholder={strings.placeholder}
      rows={1}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
    />
  );
}

export interface BarSendProps {
  disabled: boolean;
  sending: boolean;
  onClick: () => void;
}

export function BarSend({ disabled, sending, onClick }: BarSendProps) {
  return (
    <button
      type="button"
      className="k-btn k-btn--primary k-btn--sm"
      disabled={disabled}
      onClick={onClick}
    >
      {sending ? strings.sending : strings.send}
    </button>
  );
}
