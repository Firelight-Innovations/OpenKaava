/**
 * Assert that every file naming the product still agrees with `branding.toml`.
 *
 * These files are checked rather than rewritten *by the build*, and a check
 * that names each surface it checks is also the list of what a fork has to
 * replace — one piece of work answering both questions. `--fix` is what keeps
 * a rename to one file and one command without giving that up: the operator
 * asks for the rewrite, the build never does.
 *
 * `docs/branding.md` §3 has the full argument, and §5 the surfaces.
 *
 * Usage:
 *   node scripts/check-branding.mjs           report every disagreement
 *   node scripts/check-branding.mjs --list    print every surface it checks
 *   node scripts/check-branding.mjs --fix     write branding.toml's answer in
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { readBranding, repoRoot } from "./read-branding.mjs";

const { product, assets, assetPaths } = readBranding();
const fixing = process.argv.includes("--fix");

const read = (file) => readFileSync(join(repoRoot, file), "utf8");

/**
 * One surface: where it is, which part of it, what it must say, and how to find
 * that part in the raw text.
 *
 * `pattern` is deliberately three groups — prefix, value, suffix — so one
 * declaration serves both reading and rewriting, and the two cannot come to
 * disagree about which span of the file is the value.
 *
 * `after` narrows the search to the text following a literal. Two surfaces need
 * it: `kaava.toml` has a `name` key in every `[[tool]]` as well as in
 * `[stack]`, and `tauri.conf.json` has a `title` per window.
 */
function surface({ file, field, expects, expected, pattern, after }) {
  return { file, field, expects, expected, pattern, after };
}

const TAURI_CONF = "src-tauri/tauri.conf.json";
const NAME = "the product name";

const SURFACES = [
  surface({
    file: "index.html",
    field: "<title>",
    expects: NAME,
    expected: product.name,
    pattern: /(<title>)([^<]*)(<\/title>)/,
  }),

  surface({
    file: "splash.html",
    field: "<title>",
    expects: NAME,
    expected: product.name,
    pattern: /(<title>)([^<]*)(<\/title>)/,
  }),

  surface({
    file: "splash.html",
    field: ".splash__wordmark",
    expects: "the wordmark, set as written",
    expected: product.wordmark,
    pattern: /(<p class="splash__wordmark">)([^<]*)(<\/p>)/,
  }),

  surface({
    file: "kaava.toml",
    field: "[stack] name",
    expects: NAME,
    expected: product.name,
    after: "[stack]",
    pattern: /(name = ")([^"]*)(")/,
  }),

  surface({
    file: TAURI_CONF,
    field: "productName",
    expects: `${NAME} — it is also the installer's filename`,
    expected: product.name,
    pattern: /("productName":\s*")([^"]*)(")/,
  }),

  surface({
    file: TAURI_CONF,
    field: "app.windows[main].title",
    expects: NAME,
    expected: product.name,
    after: '"label": "main"',
    pattern: /("title":\s*")([^"]*)(")/,
  }),
];

/** Where the value sits in the file, so it can be reported or replaced in place. */
function locate(s, text) {
  const offset = s.after ? text.indexOf(s.after) : 0;
  if (offset < 0) return null;
  const found = s.pattern.exec(text.slice(offset));
  if (!found) return null;
  const start = offset + found.index + found[1].length;
  return { value: found[2], start, end: start + found[2].length };
}

const problems = [];
const fixed = [];

for (const s of SURFACES) {
  const text = read(s.file);
  const at = locate(s, text);
  if (at === null) {
    problems.push(`${s.file}: could not find ${s.field} — the surface moved, so nothing checks it`);
    continue;
  }
  if (at.value === s.expected) continue;

  if (fixing) {
    writeFileSync(
      join(repoRoot, s.file),
      text.slice(0, at.start) + s.expected + text.slice(at.end),
      "utf8",
    );
    fixed.push(
      `${s.file}: ${s.field} ${JSON.stringify(at.value)} -> ${JSON.stringify(s.expected)}`,
    );
  } else {
    problems.push(
      `${s.file}: ${s.field} is ${JSON.stringify(at.value)}, but branding.toml says ` +
        `${JSON.stringify(s.expected)}. Change branding.toml and re-run with --fix.`,
    );
  }
}

for (const [key, { declared, absolute }] of Object.entries(assetPaths)) {
  if (!existsSync(absolute))
    problems.push(`branding.toml: [assets] ${key} = ${declared} is missing`);
}

/**
 * Tauri names its icons individually and the set is easy to shrink by accident.
 * Every entry has to sit inside the declared directory and exist, so an icon
 * dropped from the pack fails a lint rather than an installer build.
 */
const iconRoot = assetPaths["bundle-icons"].absolute;
for (const icon of JSON.parse(read(TAURI_CONF)).bundle?.icon ?? []) {
  const absolute = resolve(join(repoRoot, "src-tauri"), icon);
  if (relative(iconRoot, absolute).startsWith("..")) {
    problems.push(`${TAURI_CONF}: bundle.icon ${icon} is outside ${assets["bundle-icons"]}`);
  } else if (!existsSync(absolute)) {
    problems.push(`${TAURI_CONF}: bundle.icon ${icon} does not exist`);
  }
}

if (process.argv.includes("--list")) {
  console.log("Surfaces that must agree with branding.toml:\n");
  for (const s of SURFACES) console.log(`  ${s.file}\n    ${s.field} — ${s.expects}`);
  console.log(`\n  ${TAURI_CONF}\n    bundle.icon — every entry inside [assets] bundle-icons`);
  console.log("\nBrand assets:\n");
  for (const [key, { declared }] of Object.entries(assetPaths))
    console.log(`  ${key} — ${declared}`);
  console.log("\nGenerated from branding.toml, so rewritten rather than checked:");
  console.log("  branding.generated.ts, in src/, apps/home/ui/src/ and apps/files/ui/src/\n");
}

for (const one of fixed) console.log(`branding: rewrote ${one}`);

if (problems.length > 0) {
  console.error(`branding: ${problems.length} problem(s)\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`branding: ${SURFACES.length} surfaces agree with branding.toml`);
