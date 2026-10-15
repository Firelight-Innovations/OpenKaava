import { useId } from "react";
import type { PickerProps } from "./types";
import "./composer.css";

/**
 * Every setting in the composer's footer: mode, model, effort, harness. A
 * picker with nothing to choose (no `onChange`) shows its value as text.
 */
export function Picker({ label, title, value, choices, disabled, onChange }: PickerProps) {
  const id = useId();
  if (!onChange) {
    return (
      <span className="at-prompt__mode" role="group" aria-label={label} title={title ?? undefined}>
        {value ?? ""}
      </span>
    );
  }
  // A value the agent reports but does not offer is still shown as it is,
  // rather than silently showing the first choice instead.
  const known = choices.some((c) => c.value === value);
  return (
    <span className="at-picker" title={title ?? undefined}>
      <label className="at-picker__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="at-picker__select"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {!known && (
          <option value={value ?? ""} disabled>
            {value ?? ""}
          </option>
        )}
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value} title={choice.description ?? undefined}>
            {choice.name || choice.value}
          </option>
        ))}
      </select>
    </span>
  );
}
