/**
 * The Problems dock tab's own data (PRD §12.14, S-13) — everything a row
 * draws or navigates to, computed from `schematify/lint`'s answer
 * (`schematify_core::LintReport`, `crates/schematify-core/src/lint.rs`).
 *
 * Pure and DOM-free, the same convention `./navigation.ts` and this
 * directory's other files follow: nothing here imports `@veistra/bridge`,
 * so it unit-tests under plain Node. `./backend.ts` is this app's only door
 * to Rust; see `fetchLintReport` there.
 *
 * **The panel formats nothing new.** `lint.rs`'s own header warns that a
 * panel which invents a cell becomes a 2nd, drifting definition of what a
 * rule found. `locationCell` below restates `Location::cell()`'s *format*
 * against data the wire already carries (`id`/`title`/`slug`) — not a 2nd
 * *answer* to what the rule found, which is the thing that rule forbids.
 */
import type { Tier } from "./types";

/** `schematify_core::registry::Severity`, `#[serde(rename_all = "lowercase")]`. */
export type Severity = "error" | "warning" | "review";

/**
 * `schematify_core::lint::Location`, exactly as it serializes
 * (`#[serde(tag = "surface", rename_all = "snake_case")]`) — already this
 * app's own naming convention field for field (`id`, `title`, `slug` need no
 * rename), so this is not a projection, just the wire type stated in full.
 */
export type Location =
  | { surface: "stack" }
  | { surface: "service"; id: string; title: string; slug: string }
  | { surface: "module"; id: string; title: string; slug: string }
  | { surface: "decision_log" }
  | { surface: "product" };

/**
 * `schematify_core::lint::Finding`, exactly as `schematify/lint` serializes
 * it (`src-tauri/src/apps/schematify.rs`'s `lint_graph`,
 * `serde_json::to_value` over `LintReport` verbatim — no `rename_all` on the
 * Rust struct). `node_cell` is the one field this app's own convention
 * renames on the way in; see [`Finding`] and [`projectFindings`].
 */
export interface RawFinding {
  rule: string;
  rule_name: string;
  severity: Severity;
  subject: string;
  node_cell: string;
  location: Location;
  detail: string;
  evidence: string[];
}

/** `schematify_core::lint::LintReport`, exactly as the wire carries it. */
export interface RawLintReport {
  findings: RawFinding[];
  nodes: number;
  edges: number;
  screens: number;
  decisions: number;
  rules: number;
}

/** One Problems row, camelCased for this app's own convention — every field
 *  but `nodeCell` already matched the wire shape, so [`projectFindings`]
 *  renames that one field and passes the rest through untouched. */
export interface Finding {
  rule: string;
  ruleName: string;
  severity: Severity;
  subject: string;
  nodeCell: string;
  location: Location;
  detail: string;
  evidence: readonly string[];
}

/** Projects `schematify/lint`'s answer to what the panel draws. Order is
 *  preserved exactly — `schematify_core::lint` already sorts errors above
 *  warnings (PRD §12.14: "A user shall never scroll to discover that an
 *  error exists"), so re-sorting here would be a second definition of an
 *  order the rule already settled. */
export function projectFindings(report: RawLintReport): Finding[] {
  return report.findings.map((f) => ({
    rule: f.rule,
    ruleName: f.rule_name,
    severity: f.severity,
    subject: f.subject,
    nodeCell: f.node_cell,
    location: f.location,
    detail: f.detail,
    evidence: f.evidence,
  }));
}

/** PRD §12.14: `● ERROR` / `▲ WARN`. `"review"` never appears in the 13
 *  rules PRD §10.4 defines — every one of `RuleId::severity`'s answers is
 *  `Error` or `Warning` (`crates/schematify-core/src/lint.rs`'s own
 *  `CATALOG`) — so `◆`/`REVIEW` are a defensive fallback this app's fixture
 *  never draws, the same shape `lint.rs`'s own `UNREGISTERED` row is. */
export function severityGlyph(severity: Severity): string {
  if (severity === "error") return "●";
  if (severity === "warning") return "▲";
  return "◆";
}

export function severityWord(severity: Severity): string {
  if (severity === "error") return "ERROR";
  if (severity === "warning") return "WARN";
  return "REVIEW";
}

/** Mirrors `schematify_core::lint::Location::cell()` — see this file's own
 *  header for why restating this one format is not the thing the crate's
 *  "nothing left to invent" rule forbids. */
export function locationCell(location: Location): string {
  switch (location.surface) {
    case "stack":
      return "Stack";
    case "service":
      return `Stack › ${location.title}`;
    case "module":
      return `› ${location.title}`;
    case "decision_log":
      return "Decision Log";
    case "product":
      return "Product";
  }
}

export interface ProblemBadges {
  errors: number;
  warnings: number;
}

/** The dock tab's 2 badges (PRD §12.1) and the Problems panel header's own
 *  grouping — both read off the same 2 numbers. */
export function problemBadges(findings: readonly Finding[]): ProblemBadges {
  let errors = 0;
  let warnings = 0;
  for (const finding of findings) {
    if (finding.severity === "error") errors += 1;
    else if (finding.severity === "warning") warnings += 1;
  }
  return { errors, warnings };
}

/** Status bar cell 3 (PRD §12.1): `3 errors · 2 warnings`. */
export function statusCell3(findings: readonly Finding[]): string {
  const { errors, warnings } = problemBadges(findings);
  return `${errors} errors · ${warnings} warnings`;
}

/** The uuid out of a `schematify://<kind>/<uuid>` reference
 *  (`crates/schematify-core/src/uri.rs`'s `Uri::to_string`) — the id
 *  `SchematicEngine.select` takes. Parses rather than assumes a fixed
 *  prefix length, since `kind` varies (`node`, `screen`, `flow`,
 *  `decision`). */
export function subjectId(subject: string): string {
  const slash = subject.lastIndexOf("/");
  return slash === -1 ? subject : subject.slice(slash + 1);
}

/** Structurally `engine/navigation.ts`'s `DrillTarget` — restated rather
 *  than imported: `graph/` is imported *by* `engine/`
 *  (`engine/index.ts`'s `import { defaultSeam } from "../graph"`), so the
 *  reverse import would be a cycle. Assignable to `DrillTarget` wherever a
 *  caller needs one, by shape alone. */
export interface NavigationTarget {
  tier: Tier;
  slug: string;
  title: string;
}

/** `engine/presets.ts`'s `STACK_CONFIG.layoutSlug` — restated for the same
 *  reason `NavigationTarget` is. There is exactly 1 Stack Schematic, and
 *  `engine/navigation.ts`'s `configFor` ignores whatever slug a stack-tier
 *  target carries (`navigation.test.ts`: "returns the stack preset
 *  unmodified"), so this literal only has to match by convention, not by
 *  import — and nothing downstream reads it as anything but an equality
 *  check against another stack-tier target. */
const STACK_SLUG = "stack";

/** Where a Problems row navigates to, or `null` when its location names no
 *  Schematic at all — `decision_log` and `product` are PRD §12.18/§12.17
 *  surfaces, not Schematics (rules L07 and L13 are the only 2 that draw
 *  them, and neither appears in the reference fixture's 5 rows). */
export function drillTargetForLocation(location: Location): NavigationTarget | null {
  switch (location.surface) {
    case "stack":
      return { tier: "stack", slug: STACK_SLUG, title: "Stack" };
    case "service":
      return { tier: "service", slug: location.slug, title: location.title };
    case "module":
      return { tier: "module", slug: location.slug, title: location.title };
    case "decision_log":
    case "product":
      return null;
  }
}

export interface ClickThrough {
  /** Present only when the target Schematic is not the one already open. */
  navigate?: NavigationTarget;
  /** The id to select once the target Schematic is open — the uuid out of
   *  `Finding.subject`. Always present when a click-through exists at all. */
  select: string;
}

/**
 * PRD §12.14: "Each row navigates to the offending node on the correct
 * Schematic." `current` is whichever Schematic `App.tsx`'s own navigation
 * path already has open. Already there, this is a plain select with no
 * navigation at all — the same "don't re-open what's already open" rule
 * `engine/navigation.ts`'s own doc comment states for a module re-clicked at
 * its own Module Schematic.
 */
export function resolveClickThrough(
  current: { tier: Tier; slug: string },
  finding: Finding,
): ClickThrough | null {
  const dest = drillTargetForLocation(finding.location);
  if (!dest) return null;
  const select = subjectId(finding.subject);
  if (dest.tier === current.tier && dest.slug === current.slug) {
    return { select };
  }
  return { navigate: dest, select };
}
