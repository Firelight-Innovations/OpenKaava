import { strings } from "../strings";
import type { ContextMeterProps } from "./types";
import "./composer.css";

/** How full the context window is: a small bar, with the numbers in its title. */
export function ContextMeter({ used, size }: ContextMeterProps) {
  if (used === null || size === null || size <= 0) return null;
  const share = Math.min(1, Math.max(0, used / size));
  const words = strings.usage(used, size);
  return (
    <span
      className="at-meter"
      role="meter"
      aria-label={words}
      aria-valuemin={0}
      aria-valuemax={size}
      aria-valuenow={used}
      title={words}
    >
      <span className="at-meter__fill" style={{ width: `${share * 100}%` }} />
    </span>
  );
}
