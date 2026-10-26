/**
 * Build the `latest.json` that Veistra's updater reads.
 *
 * `bundle.createUpdaterArtifacts` makes `tauri build` sign each installer and
 * drop a `.sig` beside it. It does **not** write the manifest that says where
 * those installers live — that is this file's job, because only the release
 * workflow knows the tag the assets are about to hang off.
 *
 * The shaping is exported and unit-tested rather than done inline in YAML. A
 * manifest is read by every installed copy of Veistra and is the one artifact in
 * the release nobody looks at: a wrong `url` is a silent no-op on every machine
 * at once, and there is no failing build to notice it.
 *
 * Usage:
 *   node scripts/update-manifest.mjs --dir artifacts --tag v0.2.0 > latest.json
 *   node scripts/update-manifest.mjs --dir artifacts --tag v0.2.0 --notes "..."
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Where the assets of a tagged release live. Public, so no token is involved. */
const REPO = "Firelight-Innovations/Veistra";

/**
 * Tauri's name for a platform, which is **not** a Rust target triple: it is
 * `<os>-<arch>` with the arch spelled the way Rust spells it. The updater
 * builds this string itself at runtime and looks it up verbatim, so a key that
 * is nearly right resolves to nothing and every machine reads "no update".
 */
const TARGETS = [
  { match: /_x64[-_]/i, key: "windows-x86_64" },
  { match: /_arm64[-_]/i, key: "windows-aarch64" },
];

/**
 * The two Windows installers, best first.
 *
 * `bundle.targets` is `["nsis"]` today, so only the setup.exe is built and only
 * it is signed — one candidate, and this ranking decides nothing. It is here
 * because that config line is one word from being `"all"`, and the day it
 * changes back a signed build produces a `.sig` for the MSI as well, both
 * claiming the same platform, with one manifest slot between them.
 *
 * NSIS wins that. It is what `plugins.updater.windows.installMode` configures,
 * it installs for the current user without an elevation prompt, and it is the
 * installer the README's download button already points at. Silently picking
 * whichever `readdir` returned first is the outcome this exists to prevent.
 */
const KINDS = [
  { match: /-setup\.exe$/i, key: "nsis" },
  { match: /\.msi$/i, key: "msi" },
];

/** Which platform and which installer a filename is, or `null` for neither. */
export function classify(filename) {
  const target = TARGETS.find((t) => t.match.test(filename))?.key;
  const kind = KINDS.findIndex((k) => k.match.test(filename));
  if (target === undefined || kind === -1) return null;
  return { target, kind: KINDS[kind].key, rank: kind };
}

/** `v0.2.0` and `0.2.0` both mean 0.2.0. The manifest carries the bare form,
 *  because that is what the updater compares against the running version. */
export function versionOf(tag) {
  const bare = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(bare)) {
    throw new Error(`${tag} is not a version this release can be about`);
  }
  return bare;
}

/**
 * The manifest, from what the build actually produced.
 *
 * `signed` is a list of `{ file, signature }` — the installer's *name*, not its
 * path, because the name is what the download URL is built from and a path
 * would let a local directory layout leak into a published document.
 *
 * Two failures are thrown rather than warned about. Nothing signed at all means
 * the build ran without a key and this manifest would offer an update that
 * cannot be verified; two installers *of the same kind* claiming one platform
 * means an artifacts directory holding more than one release, and picking
 * either would be a guess about which. Two of different kinds is the ordinary
 * case — see [`KINDS`].
 */
export function buildManifest({ tag, signed, notes, pubDate }) {
  const version = versionOf(tag);
  const base = `https://github.com/${REPO}/releases/download/${tag}`;

  const chosen = new Map();
  for (const { file, signature } of signed) {
    const what = classify(file);
    if (what === null) continue;

    const standing = chosen.get(what.target);
    if (standing !== undefined) {
      if (standing.rank === what.rank) {
        throw new Error(
          `two ${what.kind} installers claim ${what.target}: ${standing.file} and ${file}`,
        );
      }
      if (standing.rank < what.rank) continue;
    }
    chosen.set(what.target, { ...what, file, signature: signature.trim() });
  }

  if (chosen.size === 0) {
    throw new Error(
      "no signed installer was found, so there is nothing to publish a manifest about. " +
        "Was TAURI_SIGNING_PRIVATE_KEY set for the build?",
    );
  }

  return {
    version,
    notes: notes ?? defaultNotes(version),
    pub_date: pubDate ?? new Date().toISOString(),
    // Only `signature` and `url` survive. The filename and the installer kind
    // were how the URL was built; a key in a published document that nothing
    // reads is a key somebody eventually starts reading.
    platforms: Object.fromEntries(
      [...chosen].map(([target, { signature, file }]) => [
        target,
        { signature, url: `${base}/${encodeURIComponent(file)}` },
      ]),
    ),
  };
}

/**
 * What the status bar shows when nobody wrote a line for this release.
 *
 * One sentence, because that is what it is drawn into — `updater::summarise`
 * takes the first paragraph and caps it, and the full notes are a click away on
 * the release page either way.
 */
export function defaultNotes(version) {
  return `Veistra ${version} is available. The release notes are on GitHub.`;
}

/**
 * Pair every `.sig` in a directory with the installer it signs.
 *
 * Driven from the signatures rather than from the installers: an unsigned
 * installer is one this manifest must not mention, and starting from the `.sig`
 * makes that the default rather than a filter somebody has to remember.
 */
export function collect(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sig"))
    .map((name) => ({
      file: name.slice(0, -".sig".length),
      signature: readFileSync(join(dir, name), "utf8"),
    }));
}

function arg(flag) {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

function main() {
  const dir = arg("--dir");
  const tag = arg("--tag");
  if (dir === undefined || tag === undefined) {
    console.error(
      "usage: node scripts/update-manifest.mjs --dir <dir> --tag <v0.0.0> [--notes ...]",
    );
    process.exit(2);
  }

  try {
    const manifest = buildManifest({ tag, signed: collect(dir), notes: arg("--notes") });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (e) {
    console.error(`update-manifest: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
