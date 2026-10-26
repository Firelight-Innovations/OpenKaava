import { useEffect, useState, type CSSProperties } from "react";
import { RotateCcw, Zap } from "lucide-react";
import { strings } from "../strings";
import { effortIndex } from "../preferences";
import type { PickerProps } from "./types";
import "./preferences.css";

/** A real range control; drag previews color the composer and only supported stops are applied. */
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
  useEffect(() => () => onPreview?.(null), [onPreview]);
  const names = [...strings.preferences.levels, ...(ultra ? [strings.preferences.ultracode] : [])];
  const configured = effortIndex(value ?? "");
  const active = ultra?.enabled
    ? 5
    : configured >= 0
      ? configured
      : choices.some((c) => c.value === "medium")
        ? 1
        : choices.some((c) => c.value === "high")
          ? 2
          : 0;
  const stops = names.map((name, index) => ({
    name,
    index,
    choice: choices.find((c) => c.value !== "ultra" && effortIndex(c.value) === index),
    available:
      index === 5
        ? !ultra?.disabled
        : choices.some((c) => c.value !== "ultra" && effortIndex(c.value) === index),
  }));
  const supported = stops.filter((s) => s.available);
  const shown = hover ?? active;
  const apply = (index: number) => {
    if (disabled || (!onChange && !ultra) || !supported.length) return;
    const picked = [...supported].sort(
      (a, b) => Math.abs(a.index - index) - Math.abs(b.index - index),
    )[0];
    if (picked.index === 5) ultra?.onChange(true);
    else if (picked.choice) {
      if (ultra?.enabled) ultra.onChange(false);
      onChange?.(picked.choice.value);
    }
  };
  return (
    <div
      className="at-effort at-effort--slider"
      role="group"
      aria-label={label}
      data-level={shown}
      data-ultra={shown === 5 ? "" : undefined}
      style={{ "--effort-fill": `${(shown / (names.length - 1)) * 100}%` } as CSSProperties}
    >
      <div className="at-effort__heading">
        <Zap className="at-effort__icon" size={16} aria-hidden="true" />
        <strong>
          {hover === null && !ultra?.enabled && configured < 0
            ? strings.preferences.automatic
            : names[shown]}
        </strong>
        <button
          type="button"
          aria-label={strings.preferences.resetEffort}
          disabled={disabled || !onChange}
          onClick={() => {
            if (ultra?.enabled) ultra.onChange(false);
            onChange?.(
              choices.some((c) => c.value === "default")
                ? "default"
                : (supported.find((s) => s.index === 1)?.choice?.value ??
                    supported[0]?.choice?.value ??
                    "medium"),
            );
          }}
        >
          <RotateCcw size={15} />
        </button>
      </div>
      <div className="at-effort__spectrum" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="at-effort__ends">
        <span>{strings.preferences.faster}</span>
        <span>{strings.preferences.smarter}</span>
      </div>
      <div
        className="at-effort__range-wrap"
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const at = Math.max(
            0,
            Math.min(
              names.length - 1,
              Math.round(
                ((event.clientX - rect.left) / Math.max(1, rect.width)) * (names.length - 1),
              ),
            ),
          );
          setHover(at);
          onPreview?.(at === 5 ? "ultra" : ["low", "medium", "high", "xhigh", "max"][at]);
        }}
        onPointerLeave={() => {
          setHover(null);
          onPreview?.(null);
        }}
      >
        <div className="at-effort__dots" aria-hidden="true" />
        <div className="at-effort__ticks" aria-hidden="true">
          {stops.map((s) => (
            <i key={s.index} />
          ))}
        </div>
        <input
          type="range"
          aria-label={label}
          aria-valuetext={
            !ultra?.enabled && configured < 0 ? strings.preferences.automatic : names[active]
          }
          min={0}
          max={names.length - 1}
          step={1}
          value={active}
          disabled={disabled || !supported.length}
          onChange={(e) => apply(Number(e.target.value))}
          onKeyDown={(e) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key))
              return;
            e.preventDefault();
            e.stopPropagation();
            const candidates = supported.filter((s) =>
              e.key === "ArrowLeft" || e.key === "ArrowDown" ? s.index < active : s.index > active,
            );
            const next =
              e.key === "Home"
                ? supported[0]
                : e.key === "End"
                  ? supported[supported.length - 1]
                  : e.key === "ArrowLeft" || e.key === "ArrowDown"
                    ? candidates[candidates.length - 1]
                    : candidates[0];
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
            disabled={disabled || !stop.available}
            onClick={() => apply(stop.index)}
          >
            {stop.index === 5 ? strings.preferences.ultraShort : stop.name}
          </button>
        ))}
      </div>
      {ultra?.enabled && <p className="at-effort__caption">{strings.preferences.ultracodeHint}</p>}
      {choices.some((c) => c.value === "default") && (
        <button
          type="button"
          className="at-model__button"
          disabled={disabled || !onChange}
          onClick={() => {
            if (ultra?.enabled) ultra.onChange(false);
            onChange?.("default");
          }}
        >
          {strings.preferences.automatic}
        </button>
      )}
    </div>
  );
}
