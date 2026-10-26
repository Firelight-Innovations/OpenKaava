/**
 * Refuse a pull request that edits the app library, unless the maintainer wrote it.
 *
 * `catalog.toml` decides what Veistra offers to install and, through
 * `default = true`, what it downloads and runs on first launch without being
 * asked. `docs/design-notes/app-library.md` is the argument for why that is
 * worth a gate of its own, and — importantly — what this check cannot protect
 * against on its own.
 *
 * Usage:
 *   node scripts/check-catalog.mjs --base <ref> --head <ref> --author <login>
 *   node scripts/check-catalog.mjs --list      print the guarded paths and exit
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The GitHub login permitted to change the guarded paths.
 *
 * A single hard-coded login rather than a team or an org lookup, because this
 * runs with a read-only `GITHUB_TOKEN` that cannot enumerate org membership on
 * a pull request from a fork — and a check that silently degrades to "allow"
 * when it cannot answer is worse than no check. One name in one file is
 * legible, and changing it is itself a guarded edit.
 */
const MAINTAINER = "braden-seaborn";

/**
 * Paths only the maintainer may change.
 *
 * The catalog is the point. The other two are here so that neutering the check
 * cannot be done quietly in the same pull request as the change it would hide —
 * see the design note for how far that reaches.
 */
const GUARDED = ["catalog.toml", "scripts/check-catalog.mjs", ".github/workflows/catalog.yml"];

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? null : (argv[at + 1] ?? null);
};

if (argv.includes("--list")) {
  for (const path of GUARDED) console.log(path);
  process.exit(0);
}

const base = flag("base");
const head = flag("head");
const author = flag("author");

if (!base || !head) {
  console.error("catalog: --base and --head are required (got base=%s head=%s)", base, head);
  process.exit(1);
}

/**
 * The three-dot form asks "what did this branch change", measured from where it
 * forked. The two-dot form would also report every change made on `main` since
 * the fork, which would fail a pull request for somebody else's merged commit.
 */
let changed;
try {
  changed = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
} catch (err) {
  console.error(`catalog: could not diff ${base}...${head}: ${err.message}`);
  console.error("catalog: the workflow needs `fetch-depth: 0` for the base commit to be present.");
  process.exit(1);
}

const touched = GUARDED.filter((path) => changed.includes(path));

if (touched.length === 0) {
  console.log(`catalog: untouched (${changed.length} file(s) changed)`);
  process.exit(0);
}

/**
 * The pull request's *author*, not whoever triggered the run. `github.actor` is
 * the person who pushed or re-ran, so gating on it would let a maintainer's
 * re-run of somebody else's pull request pass the check.
 */
if (author === MAINTAINER) {
  console.log(`catalog: ${touched.length} guarded path(s) changed by ${author}, who may.`);
  for (const path of touched) console.log(`  ${path}`);
  process.exit(0);
}

console.error(`catalog: ${touched.length} guarded path(s) changed by ${author ?? "(unknown)"}\n`);
for (const path of touched) console.error(`  ${path}`);
console.error(
  `\nOnly ${MAINTAINER} may change these. \`catalog.toml\` decides what Veistra\n` +
    `installs by itself on first run, and a plugin core is unsandboxed — an entry\n` +
    `added here runs on every machine that installs Veistra.\n\n` +
    `If this change is wanted, ${MAINTAINER} should carry it in a pull request of\n` +
    `their own. Split the rest of this branch out and it will pass.`,
);
process.exit(1);
