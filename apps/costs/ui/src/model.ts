/**
 * Pure helpers for the Cost Tracker: money and quantity formatting, the
 * budget's tone, and grouping lines by the resource they belong to.
 */
import type { Estimate, Line } from "./rpc";

/** Where the forecast turns from on track to worth watching. */
export const WATCH_AT = 0.8;

export type Tone = "ok" | "warn" | "err";

/** `ok` under 80 % of budget, `warn` up to it, `err` past it. */
export function budgetTone(forecast: number, budget: number): Tone {
  if (budget <= 0) return "warn";
  if (forecast > budget) return "err";
  return forecast > budget * WATCH_AT ? "warn" : "ok";
}

/** `$12.34`, `<$0.01` for a cost too small to show, `$0.00` for none. */
export function money(value: number): string {
  if (value > 0 && value < 0.005) return "<$0.01";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A unit price keeps its small digits: `$0.0218`, `$0.000024`. */
export function unitPrice(value: number | null, unit: string): string {
  if (value === null) return "—";
  if (value === 0) return `free / ${unit}`;
  const text =
    value >= 1 ? value.toFixed(2) : value.toPrecision(3).replace(/(\.\d*?[1-9])0+$/, "$1");
  return `$${text} / ${unit}`;
}

/** `1,234`, `46.5`, `0.25` — at most one decimal once past 10. */
export function quantity(value: number, unit: string): string {
  const digits = value >= 10 ? 1 : 2;
  const text = value.toLocaleString("en-US", { maximumFractionDigits: digits });
  return `${text} ${unit}`;
}

/** `September`, from the estimate's own month rather than the local clock. */
export function monthName(estimate: Estimate): string {
  return new Date(estimate.monthStart).toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
}

/** Day of the month, and how many days it has, in UTC. */
export function dayOf(estimate: Estimate): { day: number; days: number } {
  const start = Date.parse(estimate.monthStart);
  const end = Date.parse(estimate.monthEnd);
  const now = Date.parse(estimate.now);
  return {
    day: Math.min(Math.floor((now - start) / 86_400_000) + 1, (end - start) / 86_400_000),
    days: Math.round((end - start) / 86_400_000),
  };
}

export interface ResourceGroup {
  resource: string;
  detail: string;
  lines: Line[];
  toDate: number;
  forecast: number;
}

/** Lines regrouped by resource, in the order the backend listed them. */
export function byResource(lines: Line[]): ResourceGroup[] {
  const groups = new Map<string, ResourceGroup>();
  for (const line of lines) {
    let group = groups.get(line.resource);
    if (!group) {
      group = { resource: line.resource, detail: line.detail, lines: [], toDate: 0, forecast: 0 };
      groups.set(line.resource, group);
    }
    group.lines.push(line);
    group.toDate += line.toDate;
    group.forecast += line.forecast;
  }
  return [...groups.values()];
}

/** `Sep 28, 1:00 PM UTC` — when the billing export last wrote a row. */
export function exportedLabel(at: string | null): string {
  if (!at) return "no rows exported yet this month";
  const text = new Date(at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `exported through ${text} UTC`;
}

/** One sentence on where the month is heading. */
export function verdict(estimate: Estimate): string {
  const gap = estimate.budget - estimate.forecast;
  if (gap >= 0) return `${money(gap)} under the ${money(estimate.budget)} budget`;
  return `${money(-gap)} over the ${money(estimate.budget)} budget`;
}
