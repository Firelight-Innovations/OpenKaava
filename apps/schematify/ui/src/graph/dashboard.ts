/**
 * The Module dashboard's own data (PRD §12.13, S-12) and the Runs dock tab's
 * (PRD §12.2, S-14) — everything both surfaces draw, computed from
 * `schematify/module-dashboard` and `schematify/runs` (`src-tauri/src/apps/schematify.rs`).
 *
 * Pure and DOM-free, the same convention `./problems.ts` follows: nothing
 * here imports `@veistra/bridge`, so it unit-tests under plain Node.
 * `./backend.ts` is this app's only door to Rust.
 *
 * Both wire shapes are hand-built JSON on the Rust side (`json!`, not a
 * `#[derive(Serialize)]` struct — see `module_dashboard`'s own doc comment),
 * already camelCase, so the `Raw*` types below are stated in full rather than
 * projected: there is no 2nd, renaming layer the way `problems.ts` needs one
 * for `node_cell`.
 */

/** `schematify/module-dashboard`'s `module` field. */
export interface DashboardModule {
  id: string;
  title: string;
  slug: string;
}

/** `schematify/module-dashboard`'s `latestRun` field, or `null` for a module
 *  CI has never run. */
export interface DashboardRun {
  run: number;
  at: string;
  commit: string;
  workflow: string;
}

/** `schematify/module-dashboard`'s `budgets` counter. */
export interface DashboardBudgetCounter {
  withProbe: number;
  total: number;
  hardMissingProbe: number;
}

/** `schematify/module-dashboard`'s `tests` counter. */
export interface DashboardTestCounter {
  passing: number;
  total: number;
  failing: number;
  unlinked: number;
}

/** `schematify/module-dashboard`'s `linter` counter, or `null` for a module
 *  with no ingested run — the `LINTER` card reads a run's own report (PRD
 *  §10.2), not the live Schematify graph linter. */
export interface DashboardLinterCounter {
  rules: number;
  violations: number;
}

/** `schematify/module-dashboard`'s `reconciliation` counter, or `null` for a
 *  module with no ingested run. */
export interface DashboardReconciliationCounter {
  matched: number;
  declaredAbsent: number;
  presentUnknown: number;
  duplicate: number;
}

/** One row of `schematify/module-dashboard`'s `reconciliationRows` — always
 *  4, one per PRD §9.2 outcome, in that table's own order. `count` (the run
 *  artifact's own declared number) and `site` (the `reconcile.json` evidence
 *  found on disk) are read from 2 independent sources and never reconciled
 *  against each other — `countMismatch` is `true` when they disagree, so a
 *  caller can surface that rather than draw a silently self-contradictory
 *  row (PRD §12.1: "Errors first · never hidden"). */
export interface ReconciliationRow {
  outcome: string;
  site: string;
  count: number;
  countMismatch: boolean;
}

/** One row of `schematify/module-dashboard`'s `budgetHistory` — one per
 *  `budget` facet the module holds, PRD §12.13's own budget-history section. */
export interface BudgetHistoryRow {
  metric: string;
  tier: "hard" | "soft" | "target";
  op: string;
  threshold: number;
  unit: string;
  hasProbe: boolean;
  probeCommand: string | null;
  /** What the latest run measured for this metric, or `null` when the
   *  metric never appeared in a run (no probe, or the module never ran). */
  latestValue: number | null;
  pass: boolean | null;
  signOff: string | null;
}

/** One row of `schematify/module-dashboard`'s `auditLog` — up to 5, newest
 *  first, PRD §12.13's `LIFECYCLE AUDIT LOG`. */
export interface AuditLogRow {
  when: string;
  from: string;
  to: string;
  actor: "human" | "agent" | "system";
  actorName: string;
  reason: string;
}

/** `schematify/module-dashboard`'s whole answer. */
export interface Dashboard {
  module: DashboardModule;
  runsPath: string;
  latestRun: DashboardRun | null;
  budgets: DashboardBudgetCounter;
  tests: DashboardTestCounter;
  linter: DashboardLinterCounter | null;
  reconciliation: DashboardReconciliationCounter | null;
  reconciliationRows: readonly ReconciliationRow[];
  budgetHistory: readonly BudgetHistoryRow[];
  auditLog: readonly AuditLogRow[];
}

/** One row of `schematify/runs` — S-14's "run number, timestamp, commit,
 *  workflow file, ingest state." */
export interface RunsRow {
  module: DashboardModule;
  run: number;
  at: string;
  commit: string;
  workflow: string;
}

/** `schematify/runs`'s whole answer. */
export interface RawRunsReport {
  runs: readonly RunsRow[];
}

/** PRD §12.13's `BUDGETS` counter form: `2 / 3`. */
export function budgetsCounter(counter: DashboardBudgetCounter): string {
  return `${counter.withProbe} / ${counter.total}`;
}

/** The `BUDGETS` note: `1 hard budget has no probe`, blank when every hard
 *  budget has one. */
export function budgetsNote(counter: DashboardBudgetCounter): string {
  if (counter.hardMissingProbe === 0) return "";
  const plural = counter.hardMissingProbe === 1 ? "" : "s";
  const verb = counter.hardMissingProbe === 1 ? "has" : "have";
  return `${counter.hardMissingProbe} hard budget${plural} ${verb} no probe`;
}

/** PRD §12.13's `TESTS` counter form: `5 / 7`. */
export function testsCounter(counter: DashboardTestCounter): string {
  return `${counter.passing} / ${counter.total}`;
}

/** The `TESTS` note: `1 failing · 1 unlinked`, omitting a part that is 0. */
export function testsNote(counter: DashboardTestCounter): string {
  const parts: string[] = [];
  if (counter.failing > 0) parts.push(`${counter.failing} failing`);
  if (counter.unlinked > 0) parts.push(`${counter.unlinked} unlinked`);
  return parts.join(" · ");
}

/** PRD §12.13's `LINTER` counter: the violation count alone, `0`. `—` when no
 *  run has ever reported one. */
export function linterCounter(linter: DashboardLinterCounter | null): string {
  return linter === null ? "—" : String(linter.violations);
}

/** The `LINTER` note: `14 rules · 0 violations`. */
export function linterNote(linter: DashboardLinterCounter | null): string {
  if (linter === null) return "No run has reported yet.";
  return `${linter.rules} rules · ${linter.violations} violations`;
}

/** PRD §12.13's `RECONCILIATION` counter: `7 / 8`, `—` with no run. */
export function reconciliationCounter(r: DashboardReconciliationCounter | null): string {
  if (r === null) return "—";
  const total = r.matched + r.declaredAbsent + r.presentUnknown + r.duplicate;
  return `${r.matched} / ${total}`;
}

/** The `RECONCILIATION` note, the first non-`matched` outcome that is above
 *  0, in PRD §9.2's drawn form — `1 declared, absent`. Blank when every
 *  outcome is `matched` or there has been no run. */
export function reconciliationNote(r: DashboardReconciliationCounter | null): string {
  if (r === null) return "";
  if (r.declaredAbsent > 0) return `${r.declaredAbsent} declared, absent`;
  if (r.presentUnknown > 0) return `${r.presentUnknown} present, unknown`;
  if (r.duplicate > 0) return `${r.duplicate} duplicate`;
  return "";
}

/** `2026-08-25T14:02:00Z` to `2026-08-25 14:02Z`, PRD §12.13's own
 *  `LATEST RUN` timestamp form. */
export function formatRunAt(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  if (!match) return iso;
  return `${match[1]} ${match[2]}Z`;
}

/** PRD §12.13's `LATEST RUN` line: run 1184, `2026-08-25 14:02Z`, `4f2c9ab`,
 *  `ci/verify.yml`, joined with ` · ` and a leading `#` on the run number
 *  (not written as a literal here — see `latestRunLine`'s own test for why). */
export function latestRunLine(run: DashboardRun | null): string {
  if (run === null) return "No run yet.";
  return `#${run.run} · ${formatRunAt(run.at)} · ${run.commit} · ${run.workflow}`;
}

/** The elapsed time since `iso`, computed at draw time and never stored —
 *  `lifecycle.rs`'s own `AuditRow` doc comment states the same rule for the
 *  audit log's own timestamps. Coarsest unit that keeps 1 significant digit:
 *  minutes under an hour, hours under a day, otherwise days. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const elapsedMs = Math.max(0, now - then);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Status bar cell 4 (PRD §12.1): `run `, a `#`-prefixed run number, and a
 *  relative age (`2h ago`), blank with no run. */
export function statusCell4(run: DashboardRun | null, now: number = Date.now()): string {
  if (run === null) return "";
  return `run #${run.run} · ${relativeTime(run.at, now)}`;
}

/** `2026-08-25T11:40:00Z` to `25 Aug 11:40`, the audit log's and the contract
 *  history's shared timestamp form (PRD §12.13). */
export function shortDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  const month = MONTHS[parsed.getUTCMonth()];
  const hours = String(parsed.getUTCHours()).padStart(2, "0");
  const minutes = String(parsed.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${hours}:${minutes}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** One audit row's `TRANSITION` cell: `reviewed → accepted`. */
export function auditTransition(row: AuditLogRow): string {
  return `${row.from} → ${row.to}`;
}

/** One audit row's `ACTOR` cell — the 2 forms PRD §12.13 draws:
 *  `m.ross · human` for a person, `◇ agent · claude-sdd` for an agent. The
 *  order genuinely differs between the two, not a formatting accident —
 *  WIREFRAME-EXTRACT.md §6.1 transcribes both forms from the wireframe
 *  verbatim. */
export function auditActorCell(row: AuditLogRow): string {
  if (row.actor === "agent") return `◇ agent · ${row.actorName}`;
  return `${row.actorName} · ${row.actor}`;
}

/** One budget row's threshold cell: `< 3 ms`. */
export function budgetThreshold(row: BudgetHistoryRow): string {
  return `${row.op} ${row.threshold} ${row.unit}`;
}

/** One budget row's latest-measurement cell: `1.8 ms`, `—` unmeasured. */
export function budgetLatestValue(row: BudgetHistoryRow): string {
  return row.latestValue === null ? "—" : `${row.latestValue} ${row.unit}`;
}

/**
 * The sign-off caption a soft, trending budget draws (PRD §8: "The dashboard
 * names the signer and the run"). The fixed lead-in is UI copy, not a
 * computed claim about how many runs a project has had — this wave's own
 * dashboard has no run history to count from (only 1 run is ever ingested
 * per node in the reference fixture) and inventing a run count would be a
 * guess the graph cannot back. `signOff` itself is the graph-derived part,
 * verbatim off `BudgetFields.sign_off` — see the wave 9d handoff for the
 * full reasoning. `null` when there is nothing to sign off.
 */
export function signOffCaption(row: BudgetHistoryRow): string | null {
  if (row.signOff === null) return null;
  return `Sign-off named: ${row.signOff}.`;
}

/** The 2-line caption PRD §12.13's `cold_start_p95` example draws for a
 *  budget with no probe. `null` when the budget has one. */
export function noProbeCaption(row: BudgetHistoryRow): readonly [string, string] | null {
  if (row.hasProbe) return null;
  return ["No probe declared", "An unmeasurable claim is a lint error, not a warning."];
}

/** PRD §12.13's storage-path header line: `runs/0192f4a1-…-a7b8/`. Read
 *  straight off the backend's own `runsPath` — see `elide_uuid` in
 *  `src-tauri/src/apps/schematify.rs` for where the elision itself happens;
 *  this app draws it, it does not recompute it. */
export function runsPathLine(dashboard: Dashboard): string {
  return dashboard.runsPath;
}

/** One row of the `CONTRACT CHANGE HISTORY` table (PRD §12.13): a date and
 *  the change. Never produced today — see `contractHistory`'s own doc
 *  comment. Kept typed so a later wave that does add a real source has a
 *  shape to fill in without touching `ModuleDashboard.tsx`. */
export interface ContractHistoryRow {
  when: string;
  change: string;
}

/**
 * `contractHistory` — **always empty. This table is unreachable, for every
 * module, until a real schema backs it.**
 *
 * No schema in `crates/schematify-core` records a per-method contract change
 * log: `AuditRow` records a lifecycle *transition*, never the edit that
 * motivated one, and a `contract-method` node keeps only its current
 * fields, overwritten on every edit (PRD §6.1's "one node per file").
 *
 * An earlier version drew PRD §16.1's 3 example rows when `moduleSlug ===
 * "token-verifier"` — review correctly rejected that: `RunsPanel.tsx` →
 * `schematify/module-dashboard` is a real, id-driven path, so a real
 * project with a module of that ordinary name would have had this app's
 * own invented history silently drawn into its own dashboard. This
 * function takes no parameter and returns `[]` unconditionally instead.
 * See the wave 9d handoff §4 for the full history.
 */
export function contractHistory(): readonly ContractHistoryRow[] {
  return [];
}
