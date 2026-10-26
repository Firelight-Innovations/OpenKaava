/**
 * Assert that the bundle identifier and the product name have not moved.
 *
 * Four things derive from the identifier and only one of them is ours: the
 * config directory holding eight stores, the WebView2 profile, the
 * single-instance mutex, and a hand-written copy in `plugins/install.rs`. Two
 * more derive from the product name: the install directory NSIS chooses, and
 * the Add/Remove Programs key its "is there an existing install" probe reads.
 *
 * Moving either is allowed. Moving either *quietly* is what took a live
 * `%APPDATA%\com.firelightinnovations.helve` out of reach and installed
 * OpenKaava beside HELVE instead of over it, with every check passing.
 * `docs/dev/user-data.md` has the full account.
 *
 * Usage:
 *   node scripts/check-identity.mjs           report every disagreement
 *   node scripts/check-identity.mjs --list    print the surfaces checked
 *   node scripts/check-identity.mjs --adopt   write the identity below to every
 *                                             surface, recording what it replaced
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The pinned identity. Literals here rather than in `branding.toml` on
 * purpose: that file is what a fork edits, and the values below are on-disk
 * contracts rather than presentation. A fork is still free to change both —
 * by editing these two lines and running `--adopt`, which is the difference
 * between a rename and a rename that strands data.
 */
export const IDENTITY = {
  identifier: "com.firelightinnovations.veistra",
  productName: "Veistra",
};

/**
 * Every product name the current one has replaced, newest first.
 *
 * Here rather than in `userdata/identity.rs` because Rust has no use for it:
 * its only two readers are the uninstall macro in `installer-hooks.nsh`, which
 * must delete `OpenWith<name>` for each, and the check below that makes sure it
 * does. `SUPERSEDED` in `identity.rs` is the identifier's equivalent and stays
 * there, because `userdata::adopt` reads it at every launch.
 *
 * `--adopt` prepends to this line. A script that rewrites its own literal is
 * unusual and is still the right home: the alternative is a constant in a
 * language that never reads it.
 */
export const SUPERSEDED_PRODUCTS = ["OpenKaava", "HELVE"];

/**
 * What `ui:build` appends. An agent's instance needs its own config directory
 * and its own single-instance mutex, or it fights whichever build the user is
 * running — see CLAUDE.md.
 */
export const AGENT_SUFFIX = ".agent";

const TAURI_CONF = "src-tauri/tauri.conf.json";
const IDENTITY_RS = "src-tauri/src/userdata/identity.rs";
const INSTALL_RS = "src-tauri/src/plugins/install.rs";
const PACKAGE_JSON = "package.json";
const HOOKS_NSH = "src-tauri/installer-hooks.nsh";

/** The files read, in the order the report names them. */
export const FILES = [TAURI_CONF, IDENTITY_RS, INSTALL_RS, PACKAGE_JSON, HOOKS_NSH];

/** A `pub const NAME: &str = "value";` in Rust, or `null` if there is none. */
export function rustConst(text, name) {
  const found = new RegExp(`const ${name}\\s*:\\s*&str\\s*=\\s*"([^"]*)"`).exec(text ?? "");
  return found ? found[1] : null;
}

/** A `pub const NAME: &[&str] = &["a", "b"];` in Rust, or `null` if there is none. */
export function rustList(text, name) {
  const found = new RegExp(`const ${name}\\s*:\\s*&\\[&str\\]\\s*=\\s*&\\[([^\\]]*)\\]`).exec(
    text ?? "",
  );
  if (!found) return null;
  return [...found[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/**
 * The identifier `ui:build` overrides with. The script embeds a JSON object in
 * a shell argument, so the quoting is escaped twice over by the time it is in
 * `package.json` — matching the key is more robust than parsing it back out.
 */
export function agentIdentifier(pkg) {
  const script = pkg?.scripts?.["ui:build"] ?? "";
  const found = /identifier\\*"\s*:\s*\\*"([^"\\]*)/.exec(script);
  return found ? found[1] : null;
}

/**
 * Every `OpenWith<name>` registry key stem the installer hooks mention, split
 * by which macro it is in. The install macro must write exactly one stem; the
 * uninstall macro must delete that one and every superseded one, or a rename
 * leaves a context-menu entry pointing at a binary that is gone.
 */
export function shellKeyStems(nsh) {
  const text = nsh ?? "";
  const split = text.indexOf("NSIS_HOOK_POSTUNINSTALL");
  const halves = split === -1 ? [text, ""] : [text.slice(0, split), text.slice(split)];
  const stems = (part) => [
    ...new Set([...part.matchAll(/OpenWith([A-Za-z0-9]+)/g)].map((m) => m[1])),
  ];
  return { install: stems(halves[0]), uninstall: stems(halves[1]) };
}

/**
 * Every disagreement between the sources and the identity, as sentences.
 *
 * Pure, and takes the file *texts* rather than paths, so the tests can hand it
 * a surface that has drifted without writing one to disk.
 */
export function problems(sources, identity = IDENTITY, supersededProducts = SUPERSEDED_PRODUCTS) {
  const found = [];
  const conf = JSON.parse(sources[TAURI_CONF] ?? "{}");
  const pkg = JSON.parse(sources[PACKAGE_JSON] ?? "{}");
  const superseded = rustList(sources[IDENTITY_RS], "SUPERSEDED") ?? [];

  const same = (where, actual, expected, consequence) => {
    if (actual !== expected) {
      found.push(
        `${where} is ${JSON.stringify(actual)}, but the identity is ` +
          `${JSON.stringify(expected)}. ${consequence}`,
      );
    }
  };

  same(
    `${TAURI_CONF} identifier`,
    conf.identifier ?? null,
    identity.identifier,
    "Changing it moves %APPDATA%\\<identifier>\\, the WebView2 profile, the " +
      "single-instance mutex and the keyring entry.",
  );
  same(
    `${TAURI_CONF} productName`,
    conf.productName ?? null,
    identity.productName,
    "Changing it moves the install directory and the Add/Remove Programs key, " +
      "so the next installer finds no previous version and installs beside it.",
  );
  same(
    `${IDENTITY_RS} IDENTIFIER`,
    rustConst(sources[IDENTITY_RS], "IDENTIFIER"),
    identity.identifier,
    "This is the constant adoption is written against.",
  );
  same(
    `${INSTALL_RS} KEYRING_SERVICE`,
    rustConst(sources[INSTALL_RS], "KEYRING_SERVICE"),
    identity.identifier,
    "The stored GitHub token hangs off this name and nothing derives it.",
  );
  same(
    `${PACKAGE_JSON} ui:build --config identifier`,
    agentIdentifier(pkg),
    identity.identifier + AGENT_SUFFIX,
    "An agent's instance would share a config directory and a mutex with the " +
      "build somebody is using.",
  );

  if (superseded.includes(identity.identifier)) {
    found.push(
      `${IDENTITY_RS} SUPERSEDED contains ${JSON.stringify(identity.identifier)}. ` +
        "A directory cannot supersede itself.",
    );
  }
  if (supersededProducts.includes(identity.productName)) {
    found.push(
      `SUPERSEDED_PRODUCTS contains ${JSON.stringify(identity.productName)}. ` +
        "The uninstaller would delete the context-menu key it just wrote.",
    );
  }

  const stems = shellKeyStems(sources[HOOKS_NSH]);
  const wantedInstall = [identity.productName];
  const wantedUninstall = [identity.productName, ...supersededProducts];
  if (stems.install.join(",") !== wantedInstall.join(",")) {
    found.push(
      `${HOOKS_NSH} writes OpenWith${stems.install.join(" and OpenWith") || "(nothing)"}, ` +
        `but the identity expects exactly OpenWith${identity.productName}.`,
    );
  }
  for (const wanted of wantedUninstall) {
    if (!stems.uninstall.includes(wanted)) {
      found.push(
        `${HOOKS_NSH}'s uninstall macro does not delete OpenWith${wanted}. ` +
          "A rename that leaves the old key behind leaves a menu entry pointing at " +
          "a binary that is no longer there.",
      );
    }
  }

  return found;
}

// --- the command ------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(repoRoot, file), "utf8");
const write = (file, text) => writeFileSync(join(repoRoot, file), text);

/** This file, which `--adopt` prepends `SUPERSEDED_PRODUCTS` in. */
const SELF = "scripts/check-identity.mjs";

/** True when this file was run rather than imported by the tests. */
const invoked =
  Boolean(process.argv[1]) && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (invoked) main();

function main() {
  if (process.argv.includes("--list")) {
    console.log(`identity: ${IDENTITY.identifier} / ${IDENTITY.productName}`);
    for (const file of FILES) console.log(`  ${file}`);
    process.exit(0);
  }

  if (process.argv.includes("--adopt")) {
    adopt();
    process.exit(0);
  }

  const sources = Object.fromEntries(FILES.map((file) => [file, read(file)]));
  const found = problems(sources);
  if (found.length === 0) {
    console.log(`identity: ${IDENTITY.identifier}, and every surface agrees`);
    return;
  }

  console.error(`identity: ${found.length} problem(s)\n`);
  for (const problem of found) console.error(`  ${problem}\n`);
  console.error(
    "  If the move is deliberate, set the values at the top of this script and run:\n\n" +
      "    node scripts/check-identity.mjs --adopt\n\n" +
      "  which writes them to every surface above and records what they replaced in\n" +
      "  SUPERSEDED, so the next launch adopts the old config directory instead of\n" +
      "  starting empty. See docs/dev/user-data.md.",
  );
  process.exit(1);
}

/**
 * Write the pinned identity everywhere and record what it replaced.
 *
 * One command for both halves, for `check-version.mjs --set`'s reason: they
 * cannot be done apart without a state where one shipped and the other did
 * not — and here that state is the data loss this whole script exists to stop.
 */
function adopt() {
  const conf = JSON.parse(read(TAURI_CONF));
  const oldIdentifier = conf.identifier;
  const oldProduct = conf.productName;

  write(
    TAURI_CONF,
    read(TAURI_CONF)
      .replace(/("identifier":\s*")[^"]*(")/, `$1${IDENTITY.identifier}$2`)
      .replace(/("productName":\s*")[^"]*(")/, `$1${IDENTITY.productName}$2`),
  );
  write(
    INSTALL_RS,
    read(INSTALL_RS).replace(
      /(const KEYRING_SERVICE\s*:\s*&str\s*=\s*")[^"]*(")/,
      `$1${IDENTITY.identifier}$2`,
    ),
  );
  write(
    PACKAGE_JSON,
    read(PACKAGE_JSON).replace(
      /(identifier\\*"\s*:\s*\\*")[^"\\]*/,
      `$1${IDENTITY.identifier}${AGENT_SUFFIX}`,
    ),
  );
  write(HOOKS_NSH, renameShellKeys(read(HOOKS_NSH), oldProduct, IDENTITY.productName));
  write(IDENTITY_RS, supersede(read(IDENTITY_RS), "SUPERSEDED", oldIdentifier));
  write(SELF, supersede(read(SELF), "SUPERSEDED_PRODUCTS", oldProduct));

  console.log(`identity: adopted ${oldIdentifier} -> ${IDENTITY.identifier}`);
  console.log(`identity: adopted ${oldProduct} -> ${IDENTITY.productName}`);
  console.log("identity: run `pnpm format` — the rewrites above do not reformat");
}

/**
 * Point the install macro at the new key stem and leave the uninstall macro
 * deleting both. Exported because getting this backwards is silent: the
 * installer writes one key and the uninstaller removes a different one.
 */
export function renameShellKeys(nsh, from, to) {
  if (!from || from === to) return nsh;
  const split = nsh.indexOf("NSIS_HOOK_POSTUNINSTALL");
  if (split === -1) return nsh;

  const head = nsh.slice(0, split).replaceAll(`OpenWith${from}`, `OpenWith${to}`);
  const paired = nsh
    .slice(split)
    .replace(
      /^([ \t]*)(DeleteRegKey HKCU "[^"]*OpenWith)([A-Za-z0-9]+)(")/gm,
      (_whole, indent, prefix, stem, close) =>
        `${indent}${prefix}${stem === from ? to : stem}${close}\n${indent}${prefix}${from}${close}`,
    );

  // A second `--adopt` would otherwise re-add a deletion the first one already
  // wrote, once per key path. Identical lines are the only duplicates this can
  // produce, so dropping repeats is the whole of the fix.
  const seen = new Set();
  const tail = paired
    .split("\n")
    .filter((line) => {
      if (!line.trim().startsWith("DeleteRegKey")) return true;
      if (seen.has(line.trim())) return false;
      seen.add(line.trim());
      return true;
    })
    .join("\n");

  return head + tail;
}

/**
 * Prepend a replaced value to a `&["a", "b"]` in Rust or an `["a", "b"]` in
 * JavaScript, newest first. Both lists this writes have that shape, and the
 * order is the contract adoption reads: a machine that has been through two
 * renames has two orphaned directories, and the newest holds the live data.
 *
 * Already-present values are left alone, so running `--adopt` twice over the
 * same rename does not grow the list.
 */
export function supersede(text, name, value) {
  const current = rustList(text, name) ?? jsList(text, name);
  if (!value || current === null || current.includes(value)) return text;

  const next = [value, ...current].map((v) => `"${v}"`).join(", ");
  return text
    .replace(
      new RegExp(`(const ${name}\\s*:\\s*&\\[&str\\]\\s*=\\s*&\\[)[^\\]]*(\\])`),
      `$1${next}$2`,
    )
    .replace(new RegExp(`(const ${name}\\s*=\\s*\\[)[^\\]]*(\\])`), `$1${next}$2`);
}

/** A `const NAME = ["a", "b"];` in JavaScript, or `null` if there is none. */
export function jsList(text, name) {
  const found = new RegExp(`const ${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(text ?? "");
  if (!found) return null;
  return [...found[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}
