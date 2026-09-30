/**
 * Read `branding.toml` for the two Node scripts that need it.
 *
 * Not a TOML parser. It reads the small grammar `branding.toml`'s own header
 * restricts itself to — `[table]` headers, `key = "value"` string entries,
 * comments and blank lines — and refuses anything else by line number.
 *
 * Rejected: taking a TOML dependency for one file, and hand-rolling a real
 * parser. Rust reads the same file with the `toml` crate, so a full parser here
 * would be a second implementation that has to agree with that one across every
 * corner of the format; a grammar small enough to be obviously correct cannot
 * disagree, because anything it does not understand is an error rather than a
 * guess.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const brandingPath = join(repoRoot, "branding.toml");

const TABLE = /^\[([a-z][a-z0-9-]*)\]$/;
const ENTRY = /^([a-z][a-z0-9-]*)\s*=\s*"([^"\\]*)"$/;

/** The keys every reader depends on, so a missing one fails here rather than downstream. */
const REQUIRED = {
  product: ["name", "wordmark", "tagline"],
  assets: ["mark", "mark-colour", "icon-source", "bundle-icons"],
};

function fail(line, message) {
  throw new Error(`branding.toml:${line}: ${message}`);
}

/** Parse the file into `{ table: { key: value } }`. */
function parse(source) {
  const tables = {};
  let current = null;

  source.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/^\s+|\s+$/g, "");
    if (line === "" || line.startsWith("#")) return;

    const table = TABLE.exec(line);
    if (table) {
      current = table[1];
      if (tables[current]) fail(index + 1, `[${current}] is declared twice`);
      tables[current] = {};
      return;
    }

    const entry = ENTRY.exec(line);
    if (!entry) {
      fail(index + 1, `expected a [table] header or key = "value", got: ${line}`);
    }
    if (current === null) fail(index + 1, `${entry[1]} sits above any [table] header`);
    if (entry[1] in tables[current]) fail(index + 1, `${current}.${entry[1]} is set twice`);
    tables[current][entry[1]] = entry[2];
  });

  return tables;
}

/**
 * The parsed file, with `assets` resolved to absolute paths.
 *
 * `assetPaths` keeps the declared, repo-relative form beside the resolved one,
 * because that is what a failure message has to quote back — an absolute path
 * on one machine is not the string anybody edits.
 */
export function readBranding() {
  const tables = parse(readFileSync(brandingPath, "utf8"));

  for (const [table, keys] of Object.entries(REQUIRED)) {
    if (!tables[table]) throw new Error(`branding.toml: no [${table}] table`);
    for (const key of keys) {
      if (!(key in tables[table])) throw new Error(`branding.toml: [${table}] has no ${key}`);
    }
  }

  const assetPaths = Object.fromEntries(
    Object.entries(tables.assets).map(([key, declared]) => [
      key,
      { declared, absolute: join(repoRoot, declared) },
    ]),
  );

  return { product: tables.product, assets: tables.assets, assetPaths };
}
