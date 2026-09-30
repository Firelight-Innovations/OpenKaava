/**
 * Which of the four kinds a file belongs to.
 *
 * The kinds are Braden's, and they cut across a different axis than the
 * five-way `SearchType` in `contract.ts`: that one was drawn from the handoff
 * crop and mixes three file kinds with "terminal output" and "tool settings",
 * which are not files. This module is the file axis only. Whether the two
 * non-file types survive is still open, and deliberately not decided here —
 * they would be a separate source, not a fifth entry in this table.
 *
 * The mapping is by extension because that is the only thing available before
 * a file is opened, and the whole point of a type filter is narrowing the set
 * you are about to search. It is wrong sometimes — a `.dat` holding prose, a
 * `.json` that is really content — and that is accepted: a filter that is
 * roughly right and instant beats one that is exactly right after sniffing
 * every file on disk.
 */
import type { SearchKind } from "./types";

/**
 * Extension → kind. Lowercase, without the dot, matching how `extensionOf`
 * below normalizes.
 *
 * Ordered by how often each kind is reached for rather than alphabetically,
 * since this is read far more often than it is edited.
 */
const KIND_BY_EXTENSION: Record<string, SearchKind> = {
  // Scripts — anything whose text is executed rather than read.
  rs: "script",
  ts: "script",
  tsx: "script",
  js: "script",
  jsx: "script",
  mjs: "script",
  cjs: "script",
  py: "script",
  ps1: "script",
  psm1: "script",
  sh: "script",
  bash: "script",
  zsh: "script",
  lua: "script",
  rb: "script",
  go: "script",
  c: "script",
  h: "script",
  cpp: "script",
  hpp: "script",
  cs: "script",
  java: "script",
  kt: "script",
  swift: "script",
  sql: "script",

  // Data — structured, machine-first, usually configuration or a payload.
  json: "data",
  jsonc: "data",
  yaml: "data",
  yml: "data",
  toml: "data",
  ini: "data",
  cfg: "data",
  conf: "data",
  env: "data",
  xml: "data",
  csv: "data",
  tsv: "data",
  dat: "data",
  lock: "data",

  // Content — what a person reads or looks at, text and media alike.
  md: "content",
  mdx: "content",
  txt: "content",
  rst: "content",
  adoc: "content",
  pdf: "content",
  doc: "content",
  docx: "content",
  rtf: "content",
  odt: "content",
  svg: "content",
  png: "content",
  jpg: "content",
  jpeg: "content",
  gif: "content",
  webp: "content",
  avif: "content",
  bmp: "content",
  ico: "content",
  mp4: "content",
  webm: "content",
  mov: "content",
  mp3: "content",
  wav: "content",
  ogg: "content",
  ttf: "content",
  otf: "content",
  woff: "content",
  woff2: "content",
  html: "content",
  css: "content",
};

/**
 * Whole filenames that are OpenKaava's own, checked before any extension.
 *
 * These have to win over the extension table: `kaava.toml` is a `.toml` and
 * would otherwise land in `data`, which is true but useless — the reason to
 * filter for OpenKaava files at all is to find the ones that configure *this*
 * tool, and burying them among every other TOML defeats that.
 */
const KAAVA_FILENAMES = new Set(["kaava.toml", "kaava.lock"]);

/** Extensions that are OpenKaava's own wherever they appear. */
const KAAVA_EXTENSIONS = new Set(["kaava"]);

/**
 * A path segment that makes everything beneath it OpenKaava's.
 *
 * Matching on the directory rather than each file inside it is what makes a
 * `.kaava/` full of otherwise-ordinary JSON classify the way a user expects.
 */
const KAAVA_DIRECTORY = ".kaava";

/** Where the kind table gives no answer. Not an error — most files are prose or unknown. */
export const DEFAULT_KIND: SearchKind = "content";

/**
 * The extension of a filename, lowercased and dotless, or `""`.
 *
 * Takes the *last* segment only, so `manifest.generated.ts` is `ts`. The Files
 * app's icon lookup walks multi-part extensions left to right instead, because
 * an icon for `.spec.ts` is more specific than one for `.ts` and specificity is
 * the point there. Here it is the opposite: `.spec.ts` and `.ts` are both
 * scripts, and treating them separately would only mean two table entries that
 * can drift apart.
 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  // A leading dot is a dotfile, not an extension — `.gitignore` has no
  // extension, and reading one off it would classify it as `gitignore`.
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Classify a file by its absolute path.
 *
 * Takes the whole path rather than just the name because the `.kaava/`
 * directory rule cannot be answered from a basename alone.
 */
export function kindOf(path: string): SearchKind {
  const normalized = path.replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const lower = name.toLowerCase();

  if (KAAVA_FILENAMES.has(lower)) return "kaava";
  if (normalized.split("/").includes(KAAVA_DIRECTORY)) return "kaava";

  const extension = extensionOf(lower);
  if (KAAVA_EXTENSIONS.has(extension)) return "kaava";

  return KIND_BY_EXTENSION[extension] ?? DEFAULT_KIND;
}

/** Display label for a kind, for the row's leading column and the filter list. */
export const KIND_LABEL: Record<SearchKind, string> = {
  script: "Scripts",
  data: "Data",
  content: "Content",
  kaava: "OpenKaava",
};

/** The order kinds are drawn in, everywhere they are listed. */
export const ALL_KINDS: SearchKind[] = ["script", "data", "content", "kaava"];

/**
 * Hits regrouped so each kind is contiguous, in `ALL_KINDS` order, keeping the
 * walk's own order inside a group. The results list draws a heading per group,
 * and the cursor indexes the flat list, so the grouping has to be settled
 * before the list is flattened rather than faked at draw time.
 */
export function orderByKind<T extends { kind: SearchKind }>(hits: T[]): T[] {
  return ALL_KINDS.flatMap((kind) => hits.filter((hit) => hit.kind === kind));
}
