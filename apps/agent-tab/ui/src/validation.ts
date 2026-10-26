/**
 * The canvas topology report (`canvas/lint`, Rust `apps/canvas/lint.rs`) read
 * back out of a tool call, so the transcript can show it as a validation card
 * rather than a wall of JSON. `lint_canvas` answers with the report itself;
 * `add_shapes` carries one under `validation`.
 */

import type { Item } from "./protocol.generated";

export interface LintCheck {
  id: string;
  label: string;
  pass: boolean;
  /** Passed, but with something worth a look (frame overlap is never a failure). */
  warn: boolean;
  hard: boolean;
  count: number;
  issues: string[];
}

export interface LintReport {
  pass: boolean;
  failedChecks: string[];
  checks: LintCheck[];
  stats: Record<string, unknown>;
}

function isReport(value: unknown): value is LintReport {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { kind?: unknown; checks?: unknown };
  return v.kind === "canvasLint" && Array.isArray(v.checks);
}

/** Whether a tool's title names the topology check, for the card shown while it runs. */
export function isLintTool(title: string): boolean {
  return /lint_canvas|canvas\/lint/.test(title);
}

/** The report in a tool's output, or `null` when there is none or it was cut short. */
export function lintReportOf(output: string): LintReport | null {
  // Every tool row asks, so most answer here without parsing anything.
  if (!output.includes('"canvasLint"')) return null;
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
  if (isReport(parsed)) return parsed;
  const nested = (parsed as { validation?: unknown } | null)?.validation;
  return isReport(nested) ? nested : null;
}

/** Where the session's canvas validation stands, for the badge under the composer. */
export interface LatestValidation {
  /** A `lint_canvas` call is still running. */
  running: boolean;
  /** The newest report that could be read, or `null` before there is one. */
  report: LintReport | null;
}

/**
 * The newest validation in the transcript, read from the same tool calls the
 * validation card is drawn from. A check still running wins; one that ended
 * without a readable report is passed over for the one before it.
 */
export function latestValidation(items: readonly Item[]): LatestValidation {
  for (let i = items.length - 1; i >= 0; i--) {
    const kind = items[i].kind;
    if (kind.kind !== "toolCall") continue;
    const lint = isLintTool(kind.title);
    if (lint && (kind.status === "pending" || kind.status === "inProgress")) {
      return { running: true, report: null };
    }
    const report = lintReportOf(kind.output);
    if (report) return { running: false, report };
  }
  return { running: false, report: null };
}
