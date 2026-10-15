import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import { strings } from "../strings";
import type { HarnessChoice, ModelMenuProps, PickerChoice, PickerProps } from "./types";
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

/** The model a harness runs, in words, or `null` for its default. */
function modelOf({ model, models }: HarnessChoice): string | null {
  if (model === null) return null;
  return models.find((m) => m.value === model)?.name || model;
}

/**
 * A harness as a section: its models, checked where it is the harness in use.
 * With none known it lists its default, and an unavailable one lists why.
 * The empty value stands for "its own default".
 */
function sectionOf(
  harness: HarnessChoice,
  current: string | null,
  onChoose: ModelMenuProps["onChoose"],
): PickerProps {
  const choices: PickerChoice[] =
    harness.unavailable !== null
      ? [{ value: "", name: harness.unavailable }]
      : harness.models.length > 0
        ? harness.models
        : [{ value: "", name: strings.defaultModel }];
  const inUse = harness.id === current && harness.unavailable === null;
  return {
    label: harness.name,
    value: inUse ? (harness.models.length > 0 ? harness.model : "") : null,
    choices,
    disabled: harness.unavailable !== null,
    onChange: onChoose && ((value) => onChoose(harness.id, value === "" ? null : value)),
  };
}

/** Every item, locked ones too: they stay focusable so a screen reader can read them. */
function itemsIn(menu: HTMLElement | null): HTMLButtonElement[] {
  return [...(menu?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? [])];
}

/**
 * The composer's one settings button: harness, model, effort and mode, read
 * as "Claude · Opus 5.5 · High". It opens a menu with a group per harness,
 * its models under it, then a section per other setting. A section without
 * `onChange` is shown but cannot be changed.
 */
export function ModelMenu({
  label,
  harness = null,
  harnesses = [],
  onChoose,
  sections: settings,
}: ModelMenuProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Start on the first setting that can change, at its checked item, so the
    // arrows move from where it is; failing that, anywhere that is checked.
    const items = itemsIn(menu.current);
    const checked = items.filter((el) => el.getAttribute("aria-checked") === "true");
    (
      checked.find((el) => el.getAttribute("aria-disabled") !== "true") ??
      checked[0] ??
      items[0]
    )?.focus();
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

  // On the root, not the menu, so the keys work from the button as well as the
  // items. The menu itself takes focus on a click that lands on no item.
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (!open) return;
    const items = itemsIn(menu.current);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => items[(i + items.length) % items.length]?.focus();
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        // Only the menu closes: no handler above it, on the page or the
        // document, acts on this Esc too.
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

  const inUse = harnesses.find((h) => h.id === harness);
  const shown = [...(inUse ? [inUse.name, modelOf(inUse)] : []), ...settings.map(nameOf)].filter(
    (name) => name !== null,
  );
  // A harness's checked item is the model it runs, so only the one in use has one.
  const sections = [...harnesses.map((h) => sectionOf(h, harness, onChoose)), ...settings];
  return (
    <span className="at-model" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className="at-model__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={[label, ...shown].join(strings.settingsSpoken)}
        title={label}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="at-model__value">{shown.join(strings.settingsJoin)}</span>
        <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={id}
          ref={menu}
          role="menu"
          aria-label={label}
          className="at-model__menu"
          tabIndex={-1}
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
                data-unavailable={section.disabled ? "" : undefined}
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
                      aria-disabled={locked}
                      className="at-model__item"
                      onClick={() => {
                        if (locked) return;
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
