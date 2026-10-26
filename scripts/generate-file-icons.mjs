/**
 * Build the shared icon set out of `material-icon-theme`, for the Files
 * explorer and the shell's search locator pane.
 *
 * The package ships 1250 SVGs and a lookup manifest. This script keeps only
 * what those callers can actually reach, and writes two things:
 *
 *   public/icons/material/*.svg               — the referenced SVGs
 *   packages/file-icons/src/manifest.generated.ts  — flattened lookup tables
 *
 * Both are gitignored. The npm package is the source of truth; nothing here is
 * vendored into the tree.
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateManifest } from "material-icon-theme";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("material-icon-theme/package.json"));
const sourceIcons = join(packageRoot, "icons");

/**
 * Why `public/` rather than the module graph: `build.assetsInlineLimit`
 * defaults to 4096 bytes, and essentially every icon in this set is under 4 KB
 * — so importing them would silently inline all 1115 as base64 data URIs inside
 * JS, paid for on every load whether or not a single one is drawn. Files in
 * `public/` are copied through verbatim, fetched only when a row that needs one
 * scrolls into view, and cached by the browser afterwards. Rendering is a plain
 * `<img src="/icons/material/folder-src.svg">` with zero JS weight.
 */
const outIcons = join(repoRoot, "public", "icons", "material");
const outManifest = join(repoRoot, "packages", "file-icons", "src", "manifest.generated.ts");

/**
 * Why `generateManifest()` rather than the prebuilt `dist/material-icons.json`:
 * they are byte-identical by default — but the default has `activeIconPack:
 * "angular"`, which claims `.service.ts`, `.guard.ts`, `.pipe.ts` and 30 other
 * extensions for Angular glyphs. Calling the generator lets us pass `""` and
 * turn the pack off, so a `service.ts` in a repo that has never heard of
 * Angular reads as TypeScript.
 */
const manifest = generateManifest({ activeIconPack: "" });

/**
 * The tables map to *definition keys*, not filenames, and the definition holds
 * a path relative to the manifest's own location:
 *
 *   fileNames["package.json"]            -> "nodejs"
 *   iconDefinitions["nodejs"].iconPath   -> "./../icons/nodejs.svg"
 *
 * Note the `./../` — the prefix is not the `../icons/` you would guess. Taking
 * the basename sidesteps the question entirely and survives the package moving
 * its icons.
 */
const definitions = manifest.iconDefinitions ?? {};
const referenced = new Set();

function svgFor(definitionKey) {
  const definition = definitions[definitionKey];
  if (!definition) throw new Error(`manifest references an undefined icon: ${definitionKey}`);
  referenced.add(definitionKey);
  return basename(definition.iconPath);
}

/** Lowercase every key so the runtime can look up with a lowercased name and stop there. */
function flatten(table) {
  const out = {};
  for (const [key, definitionKey] of Object.entries(table ?? {})) {
    const lower = key.toLowerCase();
    const svg = svgFor(definitionKey);
    if (out[lower] && out[lower] !== svg) {
      throw new Error(`lowercasing collided: ${key} wants ${svg}, already ${out[lower]}`);
    }
    out[lower] = svg;
  }
  return out;
}

const fileNames = flatten(manifest.fileNames);
const fileExtensions = flatten(manifest.fileExtensions);
const folderNames = flatten(manifest.folderNames);

/**
 * Emitted alongside `folderNames` rather than derived from it. 4589 of its 4644
 * values are just the collapsed icon plus `-open`, so the table looks like it
 * carries no information — but the other 55 are clones, whose filenames put the
 * suffix mid-string: `folder-redis.clone.svg` opens to
 * `folder-redis-open.clone.svg`, not `folder-redis.clone-open.svg`. A `-open`
 * rule would silently mis-resolve all 55.
 */
const folderNamesExpanded = flatten(manifest.folderNamesExpanded);

// `languageIds` is skipped: it keys off VS Code's language identifiers, and this
// app has no notion of one. Anything it would resolve, `fileExtensions` already
// resolves from the name alone.

/**
 * Four `fileExtensions` keys are dot-leading — `.ncurc.json`, `.ncurc.yml`,
 * `.ncurc.js`, `.wakatime-project`. Those are whole filenames filed under the
 * wrong table; no suffix rule can reach a key that starts with a dot, because a
 * leading dot begins a name rather than an extension. Move them where they
 * belong instead of teaching the resolver a special case for four entries.
 */
for (const key of Object.keys(fileExtensions)) {
  if (!key.startsWith(".")) continue;
  const svg = fileExtensions[key];
  delete fileExtensions[key];
  if (fileNames[key] && fileNames[key] !== svg) {
    throw new Error(`dot-leading extension ${key} disagrees with the fileNames entry`);
  }
  fileNames[key] = svg;
}

/**
 * Drop the decorated folder aliases; the resolver strips the decoration instead.
 *
 * The theme ships every folder name five times — `dev`, `.dev`, `_dev`, `-dev`,
 * `__dev__` — which is 3715 of the 4644 keys, duplicated again across the
 * expanded table. Emitting all of it costs 320 KB of object literal parsed at
 * startup, to express a rule `folderIconUrl` can apply in one `replace`. So
 * keep the 929 bare keys and let the resolver normalise; `bareForm` here and
 * the stripping in `folderIconUrl` must stay the same rule.
 *
 * Two things have to hold before an alias can be dropped, checked in the loop
 * below; each is exactly how the optimisation breaks silently if it doesn't.
 */
const SURROUNDING_UNDERSCORES = /^__(.+)__$/;
const LEADING_DECORATION = /^[._-]+/;
const bareForm = (name) =>
  name.replace(SURROUNDING_UNDERSCORES, "$1").replace(LEADING_DECORATION, "");

const bareFolderNames = new Set(Object.keys(folderNames).filter((name) => bareForm(name) === name));
const keptAliases = [];
let aliasesDropped = 0;
for (const name of Object.keys(folderNames)) {
  if (bareFolderNames.has(name)) continue;
  const bare = bareForm(name);

  // 1. The stripped form must be a key that survives. An alias whose bare form
  //    is absent — `__pycache__` with no `pycache` — would turn a hit into a
  //    miss and fall back to the plain folder icon with nothing to notice. Those
  //    are kept verbatim rather than dropped, which is why the resolver tries an
  //    exact lookup before it normalises.
  if (!bareFolderNames.has(bare)) {
    keptAliases.push(name);
    continue;
  }
  // 2. The alias and its bare form must agree, in *both* tables. If the theme
  //    ever gives `.dev` a different icon from `dev`, dropping `.dev` silently
  //    changes what is drawn. That is a build failure, not a fallback — there is
  //    no right answer to guess at.
  if (folderNames[bare] !== folderNames[name]) {
    throw new Error(
      `folder alias ${name} -> ${folderNames[name]} disagrees with ${bare} -> ${folderNames[bare]}`,
    );
  }
  if (folderNamesExpanded[bare] !== folderNamesExpanded[name]) {
    throw new Error(
      `folder alias ${name} opens to ${folderNamesExpanded[name]}, but ${bare} opens to ${folderNamesExpanded[bare]}`,
    );
  }

  delete folderNames[name];
  delete folderNamesExpanded[name];
  aliasesDropped++;
}

const defaults = {
  file: svgFor(manifest.file),
  folder: svgFor(manifest.folder),
  folderExpanded: svgFor(manifest.folderExpanded),
  rootFolder: svgFor(manifest.rootFolder),
  rootFolderExpanded: svgFor(manifest.rootFolderExpanded),
};

// `rootFolderNames` and `rootFolderNamesExpanded` are both empty in 5.37.0 — the
// theme has the defaults above and no per-name root overrides — so there is no
// table to emit, only the two defaults.

const svgFiles = [
  ...new Set([...referenced].map((key) => basename(definitions[key].iconPath))),
].sort();

/**
 * `public/icons/material/` is emptied on every run. This is a full recursive
 * delete of that directory, so it holds nothing but what this script puts there
 * — and since it is gitignored, anything else dropped in is gone at the next
 * `pnpm build` with no copy to restore. That is why Veistra's own hand-drawn
 * icons live in the sibling `public/icons/veistra/`, which is tracked and which
 * nothing deletes. See the header of `packages/file-icons/src/index.ts`, which
 * resolves the two sets in that order.
 */
rmSync(outIcons, { recursive: true, force: true });
mkdirSync(outIcons, { recursive: true });
for (const svg of svgFiles) copyFileSync(join(sourceIcons, svg), join(outIcons, svg));

/** One entry per line is 12,000 lines nobody reads; one line is a 130 KB line no editor enjoys. */
function literal(table) {
  const entries = Object.entries(table).map(
    ([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`,
  );
  const lines = [];
  let line = "";
  for (const entry of entries) {
    if (line.length + entry.length > 108) {
      lines.push(`  ${line}`);
      line = "";
    }
    line += `${entry},`;
  }
  if (line) lines.push(`  ${line}`);
  return `{\n${lines.join("\n")}\n}`;
}

const source = `/**
 * GENERATED by scripts/generate-file-icons.mjs from material-icon-theme.
 * Not in git, and editing it is pointless — the next build overwrites it.
 * Run \`pnpm run generate:icons\` to rebuild.
 *
 * Each table maps a lowercased name to an SVG basename under
 * \`public/icons/material/\`; the theme's definition-key indirection is already
 * resolved. Read this through \`index.ts\`, which knows the lookup order.
 */

export const defaultIcons = {
  file: ${JSON.stringify(defaults.file)},
  folder: ${JSON.stringify(defaults.folder)},
  folderExpanded: ${JSON.stringify(defaults.folderExpanded)},
  rootFolder: ${JSON.stringify(defaults.rootFolder)},
  rootFolderExpanded: ${JSON.stringify(defaults.rootFolderExpanded)},
} as const;

/** Exact filenames, including dotfiles: \`package.json\`, \`.gitignore\`, \`Cargo.toml\`. */
export const fileNames: Record<string, string> = ${literal(fileNames)};

/** Extension suffixes, longest-first at the call site: \`spec.ts\` before \`ts\`. */
export const fileExtensions: Record<string, string> = ${literal(fileExtensions)};

/**
 * Collapsed folder icons, keyed by *undecorated* name — \`src\`, not \`.src\` or
 * \`__src__\`. The theme's decorated aliases are stripped at generation time and
 * \`folderIconUrl\` re-applies the rule, so look up through it rather than
 * indexing this directly. ${keptAliases.length === 0 ? "No alias needed keeping verbatim." : `${keptAliases.length} alias(es) had no bare form and are kept verbatim: ${keptAliases.join(", ")}.`}
 */
export const folderNames: Record<string, string> = ${literal(folderNames)};

/** The same keys again, opened. Not derivable — see the note in the script. */
export const folderNamesExpanded: Record<string, string> = ${literal(folderNamesExpanded)};
`;

mkdirSync(dirname(outManifest), { recursive: true });
writeFileSync(outManifest, source, "utf8");

const bytes = svgFiles.reduce((sum, svg) => sum + readFileSync(join(outIcons, svg)).byteLength, 0);
console.log(
  `file icons: ${svgFiles.length} of ${Object.keys(definitions).length} SVGs copied ` +
    `(${(bytes / 1024).toFixed(0)} KB) to public/icons/material/`,
);
console.log(
  `  ${Object.keys(fileNames).length} file names, ${Object.keys(fileExtensions).length} extensions, ` +
    `${Object.keys(folderNames).length} folders ` +
    `(${aliasesDropped} decorated aliases stripped, ${keptAliases.length} kept verbatim)`,
);
console.log(`  manifest: ${(Buffer.byteLength(source) / 1024).toFixed(0)} KB`);
if (keptAliases.length > 0) console.log(`  aliases with no bare form: ${keptAliases.join(", ")}`);
