/**
 * One choice out of a handful, drawn in whichever of three shapes fits it.
 *
 * A native `<select>` is the one control the platform draws entirely by itself:
 * its popup is an OS menu in the OS's own colours and metrics, which in a
 * frameless shell reads as a piece of a different application. So each shape is
 * drawn by the shell from design-system classes. `selectStyle` decides which:
 * a segmented track for a short enum, a row of swatches for the accent, and a
 * `k-menu` dropdown when the labels do not fit a track.
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { selectStyle } from "./selectStyle";
import type { SelectOption } from "../../../bindings";

interface Props {
  settingKey: string;
  options: SelectOption[];
  value: string;
  label: string;
  onChange: (next: string) => void;
}

export default function SelectControl(props: Props) {
  switch (selectStyle(props.settingKey, props.options)) {
    case "swatches":
      return <Swatches {...props} />;
    case "segmented":
      return <Segmented {...props} />;
    case "menu":
      return <Menu {...props} />;
  }
}

/** A `k-tabs--segmented` track. The option's description rides along as a tooltip. */
function Segmented({ options, value, label, onChange }: Props) {
  return (
    <div className="k-tabs k-tabs--segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className="k-tab settings-segment"
          role="radio"
          aria-checked={option.value === value}
          aria-selected={option.value === value}
          title={option.description === "" ? undefined : option.description}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The accent options as colour dots. Each paints `var(--accent-<value>)`, which
 * `tokens.css` defines for both themes, so a swatch is always the colour the
 * accent would actually become in the theme on screen. The name is the tooltip.
 */
function Swatches({ options, value, label, onChange }: Props) {
  return (
    <div className="settings-swatches" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className="settings-swatch"
          role="radio"
          aria-checked={option.value === value}
          aria-label={option.label}
          title={
            option.description === "" ? option.label : `${option.label}: ${option.description}`
          }
          style={{ background: `var(--accent-${option.value})` }}
          onClick={() => onChange(option.value)}
        >
          {option.value === value && <Check size={16} strokeWidth={2} aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}

/** A field-shaped trigger that opens a `k-menu`. Closes on outside click and Escape. */
function Menu({ options, value, label, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div
      className="settings-menu"
      ref={root}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        // Closes the menu and nothing else: the screen's own Escape listener
        // means "leave settings", and one press should not do both.
        event.stopPropagation();
        setOpen(false);
      }}
    >
      <button
        type="button"
        className="settings-menu__trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="settings-menu__value">{current?.label ?? ""}</span>
        <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {open && (
        <div className="k-menu settings-menu__popup" role="listbox" aria-label={label}>
          {options.map((option) => (
            <button
              type="button"
              key={option.value}
              className="k-menu__item"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                setOpen(false);
                onChange(option.value);
              }}
            >
              <span className="settings-menu__item-text">
                <span>{option.label}</span>
                {option.description !== "" && (
                  <span className="settings-menu__item-description">{option.description}</span>
                )}
              </span>
              {option.value === value && <Check size={16} strokeWidth={1.5} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
