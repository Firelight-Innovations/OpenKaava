/**
 * The numbers behind the composer's meters: how full the context window is,
 * and how much of each usage limit is gone. Kept out of the components, so a
 * replacement ring or card reads the same thresholds as the default one.
 */
import type { Item } from "./protocol.generated";

/** How worried a meter should look. Each tone is one `--k-meter-*` token. */
export type Tone = "low" | "high" | "full";

/** `high` from 80%, where a limit is worth a glance; `full` from 95%. */
export function toneOf(share: number): Tone {
  if (share >= 0.95) return "full";
  if (share >= 0.8) return "high";
  return "low";
}

/** `part / whole`, clamped to 0..1, and 0 when there is no whole to divide by. */
export function shareOf(part: number, whole: number): number {
  if (!(whole > 0)) return 0;
  return Math.min(1, Math.max(0, part / whole));
}

/** The latest usage report in the transcript, or nulls before one arrives. */
export function latestUsage(items: readonly Item[]): { used: number | null; size: number | null } {
  for (let i = items.length - 1; i >= 0; i--) {
    const kind = items[i].kind;
    if (kind.kind === "usage") return { used: kind.used, size: kind.size };
  }
  return { used: null, size: null };
}
