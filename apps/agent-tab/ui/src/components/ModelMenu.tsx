import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ModelMenuProps, PickerChoice, PickerProps } from "./types";
import "./meters.css";

/** A section's choices, with a value the agent reports but does not offer kept in. */
function choicesOf({ value, choices }: PickerProps): PickerChoice[] {
  if (value === null || choices.some((c) => c.value === value)) return choices;
  return [{ value, name: value }, ...choices];
}

/** What a section is set to, in words, or `null` when it is unset. */
function nameOf(section: PickerProps): string | null {
  if (section.value === null) return null;
  const choice = section.choices.find((c) => c.value === section.value);
  return choice?.name || section.value;
}

function itemsIn(menu: HTMLElement | null): HTMLButtonElement[] {
  return [
    ...(menu?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]:not(:disabled)") ?? []),
  ];
}

/**
 * The composer's one settings button: harness, model, effort and mode, read
 * as "Claude · Opus 5.5 · High". It opens a menu with a section per setting;
 * a section without `onChange` is shown but cannot be changed.
 */
export function ModelMenu({ label, sections }: ModelMenuProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Start on the checked item, so arrows move from where the setting is.
    const items = itemsIn(menu.current);
    (items.find((el) => el.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = itemsIn(menu.current);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => items[(i + items.length) % items.length]?.focus();
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        // Esc also stops the turn from the composer; here it only closes.
        event.stopPropagation();
        close();
        break;
      case "ArrowDown":
        event.preventDefault();
        go(at + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        go(at - 1);
        break;
      case "Home":
        event.preventDefault();
        go(0);
        break;
      case "End":
        event.preventDefault();
        go(items.length - 1);
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  const shown = sections.map(nameOf).filter((name) => name !== null);
  return (
    <span className="at-model" ref={root}>
      <button
        ref={button}
        type="button"
        className="at-model__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`${label}: ${shown.join(", ")}`}
        title={label}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="at-model__value">{shown.join(" · ")}</span>
        <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={id}
          ref={menu}
          role="menu"
          aria-label={label}
          className="at-model__menu"
          onKeyDown={onKeyDown}
        >
          {sections.map((section) => {
            const choices = choicesOf(section);
            if (choices.length === 0) return null;
            const locked = !section.onChange || section.disabled === true;
            return (
              <div
                key={section.label}
                role="group"
                aria-label={section.label}
                className="at-model__group"
                title={section.title ?? undefined}
              >
                <div className="at-model__heading" aria-hidden="true">
                  {section.label}
                </div>
                {choices.map((choice) => {
                  const checked = choice.value === section.value;
                  return (
                    <button
                      key={choice.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={checked}
                      disabled={locked}
                      className="at-model__item"
                      onClick={() => {
                        if (!checked) section.onChange?.(choice.value);
                        close();
                      }}
                    >
                      <span className="at-model__check">
                        {checked && <Check size={14} strokeWidth={2} aria-hidden="true" />}
                      </span>
                      <span className="at-model__name">{choice.name || choice.value}</span>
                      {choice.description && (
                        <span className="at-model__detail">{choice.description}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}
