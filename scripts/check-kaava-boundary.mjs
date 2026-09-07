/**
 * Block a pull request that writes to a `.kaava/nodes/` tree and its sibling
 * `.kaava/runs/` tree together, with the lifecycle pair (PRD §6.3) as the one
 * exception.
 *
 * PRD §6.2: `nodes/` (and `edges/`, `rules/`, `screens/`, `flows/`,
 * `decisions/`, `registry/`, `brief.json`) is semantic, human-authored design.
 * `runs/` is audit — append-only, written by a CI job or a lifecycle
 * transition. A pull request editing both trees at once is either a lifecycle
 * transition (allowed, see below) or a design edit smuggled in beside an audit
 * write, which this check exists to catch structurally rather than by review.
 *
 * Usage:
 *   node scripts/check-kaava-boundary.mjs --base <ref> --head <ref>
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Matches a changed path under some `.../.kaava/nodes/<uuid>.json` and
 * captures the `.kaava` root (everything before `nodes/`) and the uuid.
 * `runs/<uuid>/...` uses the analogous pattern below. Forward slashes only —
 * `git diff --name-only` always reports POSIX separators, on Windows included.
 *
 * The leading directory is optional, and that is load-bearing rather than
 * defensive. These read `.*\/\.kaava` until 2026-09-06, which requires a slash
 * before `.kaava` and therefore could not match `.kaava/nodes/<uuid>.json` at
 * the repository root — the one case the comment above and `.github/CODEOWNERS`
 * both name explicitly. The gate silently covered the three fixtures and
 * nothing else, and it stayed silent because a pattern that matches nothing
 * reports no violation.
 */
const NODE_FILE = /^(?<root>(?:.*\/)?\.kaava)\/nodes\/(?<uuid>[^/]+)\.json$/;
const RUNS_FILE = /^(?<root>(?:.*\/)?\.kaava)\/runs\/(?<uuid>[^/]+)\/(?<rest>.+)$/;

/**
 * Groups changed files by `.kaava` root and classifies each into its nodes/
 * and runs/ touches. Files outside both trees are irrelevant to this check and
 * dropped.
 *
 * Exported so the test file can feed it a fixed file list instead of a real
 * git diff — the whole point of this check is a decision over a *set of
 * paths*, and pinning that down is what a fixture read off disk cannot do
 * (either the tree already obeys the exception, or it does not exist yet).
 */
export function groupByRoot(changedFiles) {
  const roots = new Map();
  for (const path of changedFiles) {
    const nodeMatch = NODE_FILE.exec(path);
    if (nodeMatch) {
      const { root, uuid } = nodeMatch.groups;
      const entry = roots.get(root) ?? { nodes: [], runs: [] };
      entry.nodes.push({ path, uuid });
      roots.set(root, entry);
      continue;
    }
    const runsMatch = RUNS_FILE.exec(path);
    if (runsMatch) {
      const { root, uuid, rest } = runsMatch.groups;
      const entry = roots.get(root) ?? { nodes: [], runs: [] };
      entry.runs.push({ path, uuid, rest });
      roots.set(root, entry);
    }
  }
  return roots;
}

/**
 * Whether one root's touched nodes/ and runs/ files are exactly the lifecycle
 * pair from PRD §6.3: one `nodes/<uuid>.json`, one `runs/<same uuid>/audit.json`,
 * and nothing else in either tree.
 *
 * PRD §6.3 in full: "A lifecycle transition writes `nodes/<uuid>.json` and
 * appends `runs/<node-uuid>/audit.json` in one action... The gate shall block
 * every other write that touches `runs/` and `nodes/` together." The exception
 * is narrow, and shaped exactly like the transition — which is why "nothing
 * else in either tree" is a condition rather than a nicety.
 */
function isLifecyclePair(entry) {
  if (entry.nodes.length !== 1 || entry.runs.length !== 1) return false;
  const [node] = entry.nodes;
  const [run] = entry.runs;
  return node.uuid === run.uuid && run.rest === "audit.json";
}

/**
 * Returns one problem string per `.kaava` root that touches both trees
 * without matching the lifecycle exception, or `[]` when the pull request is
 * clean. A root touching only one tree is never a problem, regardless of how
 * many files move in it — the boundary this check enforces is between the two
 * trees, not a limit on write volume.
 *
 * The repository can hold more than one `.kaava/` tree at once (today, four —
 * `crates/schematify-core/fixtures/{dense-service,saas-backend,stress-2000}`
 * and the project at the repository root). Each is judged on its own:
 * regenerating one fixture's `runs/` and another fixture's `nodes/` in a single
 * pull request is two single-tree writes rather than one mixed write, and
 * passes.
 */
export function violations(changedFiles) {
  const roots = groupByRoot(changedFiles);
  const found = [];
  for (const [root, entry] of roots) {
    if (entry.nodes.length === 0 || entry.runs.length === 0) continue;
    if (isLifecyclePair(entry)) continue;
    const touched = [...entry.nodes.map((n) => n.path), ...entry.runs.map((r) => r.path)].sort();
    found.push({ root, touched });
  }
  return found;
}

function formatViolation({ root, touched }) {
  const lines = touched.map((path) => `    ${path}`).join("\n");
  return `  ${root}/ — nodes/ and runs/ both touched, and not as the lifecycle pair:\n` + lines;
}

// --- CLI driver -------------------------------------------------------------
// Only runs when this file is executed directly, so vitest importing the
// functions above never shells out to git.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? null : (argv[at + 1] ?? null);
  };

  const base = flag("base");
  const head = flag("head");

  if (!base || !head) {
    console.error(`kaava-boundary: --base and --head are required (got base=${base} head=${head})`);
    process.exit(1);
  }

  let changed;
  try {
    // Three-dot form: what did this branch change, measured from where it
    // forked from base — not everything base has picked up since.
    changed = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (err) {
    console.error(`kaava-boundary: could not diff ${base}...${head}: ${err.message}`);
    console.error(
      "kaava-boundary: the workflow needs `fetch-depth: 0` for the base commit to be present.",
    );
    process.exit(1);
  }

  const found = violations(changed);

  if (found.length === 0) {
    console.log(`kaava-boundary: clean (${changed.length} file(s) changed)`);
    process.exit(0);
  }

  console.error(
    `kaava-boundary: ${found.length} \`.kaava\` root(s) write to nodes/ and runs/ together:\n`,
  );
  for (const v of found) console.error(formatViolation(v));
  console.error(
    "\nnodes/ (and edges/, rules/, screens/, flows/, decisions/, registry/, brief.json) is\n" +
      "semantic design data. runs/ is an append-only audit trail written by a CI job or a\n" +
      "lifecycle transition. PRD §6.3 allows exactly one pair together: one nodes/<uuid>.json\n" +
      "and that same uuid's runs/<uuid>/audit.json, nothing else. Split the design edit and\n" +
      "the audit write into separate pull requests, or check that the pair above really is\n" +
      "one lifecycle transition and nothing rode along with it.",
  );
  process.exit(1);
}
