import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { RotateCcw } from "lucide-react";
import { strings } from "../strings";
import { effortIndex } from "../preferences";
import type { PickerProps } from "./types";
import "./preferences.css";

/** Each stop's wire value, in order; the sixth stop is Ultra. */
const WIRE = ["low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * Effort as a charge: a capsule that fills and heats up stop by stop, cool to
 * hot, with Ultra running the whole ramp. A real range input under it takes
 * the keys; the stop names under it take clicks. Dragging previews a level in
 * the capsule and the composer and applies it on release, snapped to a stop
 * the model supports.
 */
export function EffortPicker({
  value,
  choices,
  onChange,
  disabled,
  label,
  ultra,
  onPreview,
}: PickerProps) {
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);
  // The slider keeps the keys: a click on a stop name, or the reset going away, lands focus here.
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => () => onPreview?.(null), [onPreview]);
  // Turning Ultra on flares the capsule and crackles the thumb once, then it holds still.
  const [surge, setSurge] = useState(false);
  const wasUltra = useRef(ultra?.enabled ?? false);
  useEffect(() => {
    const now = ultra?.enabled ?? false;
    const was = wasUltra.current;
    wasUltra.current = now;
    if (now === was) return;
    setSurge(now);
    if (!now) return;
    const timer = window.setTimeout(() => setSurge(false), 1200);
    return () => window.clearTimeout(timer);
  }, [ultra?.enabled]);
  const names = [...strings.preferences.levels, ...(ultra ? [strings.preferences.ultracode] : [])];
  const configured = effortIndex(value ?? "");
  const unset = !ultra?.enabled && configured < 0;
  const active = ultra?.enabled ? 5 : configured;
  const stops = names.map((name, index) => {
    const choice = choices.find((c) => c.value !== "ultra" && effortIndex(c.value) === index);
    return {
      name,
      index,
      choice,
      available: index === 5 ? !ultra?.disabled : choice !== undefined,
    };
  });
  const supported = stops.filter((s) => s.available);
  const locked = disabled || (!onChange && !ultra) || !supported.length;
  const shown = hover ?? active;
  const nearest = (index: number) =>
    [...supported].sort((a, b) => Math.abs(a.index - index) - Math.abs(b.index - index))[0];
  const apply = (index: number) => {
    if (locked) return;
    const picked = nearest(index);
    if (picked.index === 5) ultra?.onChange(true);
    else if (picked.choice) {
      if (ultra?.enabled) ultra.onChange(false);
      onChange?.(picked.choice.value);
    }
  };
  const preview = (index: number | null) => {
    setHover(index);
    onPreview?.(index === null ? null : WIRE[index]);
  };
  // The stops' centres run from 10px in at one end to 10px in at the other (preferences.css).
  const stopAt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const span = Math.max(1, rect.width - 20);
    const at = Math.round(((event.clientX - rect.left - 10) / span) * (names.length - 1));
    return nearest(Math.max(0, Math.min(names.length - 1, at))).index;
  };
  const reset = () => {
    // The button is gone once the level is back at the default; focus must not go with it.
    input.current?.focus();
    if (ultra?.enabled) ultra.onChange(false);
    onChange?.(
      choices.some((c) => c.value === "default")
        ? "default"
        : (stops[1].choice?.value ?? supported[0]?.choice?.value ?? "medium"),
    );
  };
  const atDefault = unset || (!choices.some((c) => c.value === "default") && active === 1);
  return (
    <div
      className="at-effort"
      role="group"
      aria-label={label}
      data-level={shown < 0 ? undefined : WIRE[shown]}
      data-unset={hover === null && unset ? "" : undefined}
      data-locked={locked ? "" : undefined}
      data-surge={surge ? "" : undefined}
      style={
        {
          "--stops": names.length,
          // Unset, the hollow thumb waits at Medium, where most models start.
          "--at": shown < 0 ? 1 : shown,
          "--heat": shown < 0 ? 0 : shown / 5,
        } as CSSProperties
      }
    >
      <div className="at-effort__head">
        <span className="at-model__heading">{label}</span>
        {unset ? (
          <span className="at-effort__default">{strings.preferences.automatic}</span>
        ) : (
          !atDefault &&
          onChange && (
            <button
              type="button"
              className="at-effort__reset"
              aria-label={strings.preferences.resetEffort}
              title={strings.preferences.resetEffort}
              disabled={disabled}
              onClick={reset}
            >
              <RotateCcw size={12} aria-hidden="true" />
            </button>
          )
        )}
      </div>
      <div
        className="at-effort__track"
        onPointerDown={(event) => {
          if (locked || event.button !== 0) return;
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          preview(stopAt(event));
        }}
        onPointerMove={(event) => {
          if (!locked) preview(stopAt(event));
        }}
        onPointerUp={(event) => {
          if (!dragging.current) return;
          dragging.current = false;
          const at = stopAt(event);
          if (at !== active) apply(at);
          preview(null);
        }}
        onPointerCancel={() => {
          dragging.current = false;
          preview(null);
        }}
        onPointerLeave={() => {
          if (!dragging.current) preview(null);
        }}
      >
        <span className="at-effort__stops" aria-hidden="true">
          {stops.map((s) => (
            <i key={s.index} data-off={s.available ? undefined : ""} />
          ))}
        </span>
        <span className="at-effort__fill" aria-hidden="true">
          {/* Keyed on the level, so the glint sweeps once each time it changes. */}
          <span className="at-effort__glint" key={shown} />
        </span>
        <span className="at-effort__thumb" aria-hidden="true" />
        <input
          ref={input}
          type="range"
          aria-label={label}
          aria-valuetext={unset ? strings.preferences.automatic : names[active]}
          min={0}
          max={names.length - 1}
          step={1}
          value={Math.max(0, active)}
          disabled={locked}
          onChange={(e) => apply(Number(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              // Up and Down move through the menu, as on every other row.
              e.preventDefault();
              return;
            }
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
            e.preventDefault();
            e.stopPropagation();
            const from = active < 0 ? 1 : active;
            const left = supported.filter((s) => s.index < from);
            const right = supported.filter((s) => s.index > from);
            const next =
              e.key === "Home"
                ? supported[0]
                : e.key === "End"
                  ? supported[supported.length - 1]
                  : e.key === "ArrowLeft"
                    ? left[left.length - 1]
                    : right[0];
            if (next) apply(next.index);
          }}
        />
      </div>
      <div className="at-effort__labels">
        {stops.map((stop) => (
          <button
            type="button"
            key={stop.name}
            aria-label={stop.name}
            aria-pressed={active === stop.index}
            data-level={WIRE[stop.index]}
            style={{ "--i": stop.index } as CSSProperties}
            disabled={disabled || !stop.available}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              apply(stop.index);
              input.current?.focus();
            }}
            onPointerEnter={() => {
              if (!locked && stop.available) preview(stop.index);
            }}
            onPointerLeave={() => preview(null)}
          >
            {stop.index === 5 ? strings.preferences.ultraShort : stop.name}
          </button>
        ))}
      </div>
      {ultra?.enabled && <p className="at-effort__caption">{strings.preferences.ultracodeHint}</p>}
    </div>
  );
}
