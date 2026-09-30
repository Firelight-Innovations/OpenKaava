/**
 * The only module in this directory that touches `monaco-editor`.
 *
 * `PreviewPane.tsx` reads as a React component and a state machine; everything
 * Monaco-shaped — the worker environment, the language registrations, the
 * theme, and the handful of factory functions the pane needs — lives here,
 * mirroring the split `apps/files/ui/src/viewer/monaco.ts` draws for the same
 * reason (see that file's header).
 *
 * Two existing integrations were mined for this one and neither could simply
 * be imported. `docs/design-notes/shell-search.md` records what came from
 * `src/shell/diff/DiffView.tsx`, what from `apps/files/ui/src/viewer/monaco.ts`,
 * and why. Comments below mark what came from where.
 *
 * Imported from `monaco-editor/editor/editor.api`, not `.../editor.main`, for
 * the reason DiffView's header gives: `editor.main` registers every bundled
 * language and the full IntelliSense infrastructure as an import side effect,
 * none of which a read-only preview needs.
 */
import * as monaco from "monaco-editor/editor/editor.api";

/**
 * A curated set of languages, one `register.js` each — ported from the list in
 * `apps/files/ui/src/viewer/monaco.ts`, minus two of its entries.
 *
 * Each registers an id and a *lazy* loader, so the grammar itself is a chunk
 * fetched the first time a file of that language is previewed; listing one here
 * costs a few hundred bytes, not a grammar. That is what "real syntax
 * highlighting" (the brief) costs beyond DiffView's zero.
 *
 * One thing Files' list has that this one does not: `features/register.all`.
 * That barrel gives an *editable* buffer its find widget, context menu,
 * folding and multi-cursor — Files measured it at nearly a third of that app's
 * editor chunk. A read-only glance pane needs none of it; `revealLineInCenter`
 * and decorations are core `editor.api`, not contributions. If this pane ever
 * grows in-place find, that cost gets re-measured then, the way Files did.
 *
 * TOML is absent because it is not one of Monaco's — see `registerToml` below.
 */
import "monaco-editor/languages/definitions/rust/register";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/html/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/cpp/register";
import "monaco-editor/languages/definitions/shell/register";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/languages/definitions/xml/register";
import "monaco-editor/languages/definitions/ini/register";

/**
 * JSON, kept in even though it costs its own worker chunk. There is no
 * `languages/definitions/json` — as Files' header explains, this import *is*
 * how the `json` language id comes to exist, and it brings a real language
 * service (validation, hover, folding) with it, not just a tokenizer. More than
 * a preview needs, but there is no lighter path to JSON syntax colour in this
 * Monaco build, and `package.json`/`tsconfig.json` are common enough hits that
 * flat text would be a visible gap. The extra chunk is lazy — fetched only the
 * first time a `.json` file is previewed — so nothing pays for it until then.
 */
import { jsonDefaults } from "monaco-editor/languages/features/json/register";

import { registerToml } from "@openkaava/monaco-languages";
import { accentThemeColors } from "@openkaava/bridge/theme";
import { onThemeChange } from "../themeBroadcast";

import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker";

/**
 * Two workers, dispatched by label — ported verbatim from Files' `monaco.ts`.
 * Files' header explains why this can't be simplified to one worker: the moment
 * `MonacoEnvironment.getWorker` exists it wins unconditionally over whatever a
 * language service would otherwise supply, so a single generic worker doesn't
 * just skip JSON's features, it hangs the first request for one of them.
 * Module-scoped, like DiffView's, so it is set once when this chunk evaluates.
 */
self.MonacoEnvironment = {
  getWorker: (_workerId, label) => (label === "json" ? new JsonWorker() : new EditorWorker()),
};

/**
 * No schema fetching, ever — same setting, same reasoning, as Files' copy: a
 * desktop app previewing a JSON file should not quietly reach the network for
 * its `$schema`. Structural validation still runs; only remote resolution is
 * off.
 */
jsonDefaults.setDiagnosticsOptions({
  ...jsonDefaults.diagnosticsOptions,
  enableSchemaRequest: false,
});

/**
 * TOML, the one language here that Monaco does not ship at all. It matters more
 * than its file count suggests: `kaava.toml` and `<project>.kaava` are the
 * format behind an entire quarter of the search filter — the OpenKaava kind in
 * `./kinds.ts` is, today, exactly these two files — so flat grey text would
 * have made the one file type this product names after itself the one file type
 * it could not colour.
 *
 * `registerToml` is idempotent by design; `@openkaava/monaco-languages`'s header
 * explains why that guard exists rather than being belt-and-braces:
 * `diff/DiffView.tsx` calls it too, and shares this module's JS context.
 */
registerToml(monaco);

/**
 * Extension → language id, restated from `LANGUAGE_BY_EXTENSION` in Files'
 * `monaco.ts` and pruned to the languages actually registered above. Keys are
 * lowercase and dot-less. Anything absent gets no language and renders as plain
 * text — a wrong grammar would be worse than none, same rule Files' table
 * states for itself.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  rs: "rust",

  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",

  css: "css",
  html: "html",
  htm: "html",
  xml: "xml",

  md: "markdown",
  markdown: "markdown",

  py: "python",

  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",

  sh: "shell",
  bash: "shell",
  zsh: "shell",

  yml: "yaml",
  yaml: "yaml",

  json: "json",

  ini: "ini",
  cfg: "ini",

  /**
   * TOML, and OpenKaava's own marker with it. `<project>.kaava` *is* TOML —
   * `project/marker.rs` reads one with `raw.parse::<toml::Table>()` — so the
   * extension is OpenKaava's and the format is not, which is why one grammar
   * serves both rather than there being a second to keep in step.
   */
  toml: "toml",
  kaava: "toml",
};

/** The Monaco language id for a file, or `undefined` for plain text. */
function languageFor(extension: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[extension];
}

/**
 * The preview's theme, defined once at module scope — not per-mount, for the
 * reason DiffView's and Files' copies both give: `defineTheme` writes into
 * Monaco's global theme registry, so redefining it on every mount would be
 * repeated work for no visual change.
 *
 * Named `kaava-preview-dark`, deliberately **not** `kaava-dark`. DiffView also
 * registers a theme called `kaava-dark`, and that module shares this one's JS
 * context — both are shell-side, so both chunks can be live in the same page at
 * once, unlike Files' copy, which sits behind an iframe boundary and never
 * collides with either. Two `defineTheme("kaava-dark", ...)` calls from two
 * different chunks would make whichever evaluates second win, silently, for
 * both. A distinct name sidesteps the question of evaluation order entirely
 * rather than relying on it.
 */
export const THEME = "kaava-preview-dark";

/**
 * The colours themselves are the same ~45 mappings from Files' `kaava-dark`,
 * copied rather than DiffView's four — DiffView only themes a diff's two
 * inserted/removed backgrounds, and this pane is a full read-only editor with
 * find/selection/suggest/menu surfaces of its own (inert here, but still
 * painted if Monaco ever draws them). Every value below is `src/tokens.css`,
 * named in the comment beside it, exactly as Files' original documents.
 * Monaco's theme API takes colour *strings*, so this is the one place in this
 * directory a literal hex is unavoidable.
 *
 * Alphas are 8-digit `#RRGGBBAA`, not `rgba()` — seen the hard way once
 * already: DiffView's header records that `Color.fromHex` silently falls back
 * to opaque red for a CSS `rgba()` string. The suffix is `round(alpha * 255)`.
 */
const BASE_COLORS: Record<string, string> = {
  // --- the page ---------------------------------------------------------
  "editor.background": "#14161a", // --bg
  "editor.foreground": "#e4e7ec", // --text
  "editorGutter.background": "#14161a", // --bg
  "editorLineNumber.foreground": "#4a505b", // --text-faint
  "editorLineNumber.activeForeground": "#949cab", // --text-dim
  "editor.lineHighlightBackground": "#1b1e24", // --surface
  "editor.lineHighlightBorder": "#1b1e24", // --surface

  // --- find ---------------------------------------------------------------
  "editor.findMatchBackground": "#d9a93f59", // --warn @ 0.35
  "editor.findMatchHighlightBackground": "#d9a93f2e", // --warn @ 0.18
  "editor.findRangeHighlightBackground": "#d9a93f14", // --warn @ 0.08

  // --- structure ----------------------------------------------------------
  "editorBracketMatch.background": "#22262e", // --surface-2
  "editorIndentGuide.background1": "#2c313b", // --line
  "editorIndentGuide.activeBackground1": "#3a404b", // --line-2
  "editorWhitespace.foreground": "#3a404b", // --line-2
  "editorRuler.foreground": "#2c313b", // --line
  "editorOverviewRuler.border": "#2c313b", // --line

  // --- scrollbar ------------------------------------------------------------
  "scrollbarSlider.background": "#2c313b80", // --line @ 0.50
  "scrollbarSlider.hoverBackground": "#3a404bb3", // --line-2 @ 0.70
  "scrollbarSlider.activeBackground": "#3a404b", // --line-2

  // --- minimap (unused here — minimap is off, see mountPreviewEditor — but
  // defined for parity with Files' theme, since Monaco still resolves these
  // keys against whatever base colours are missing) ------------------------
  "minimap.background": "#14161a", // --bg
  "minimapSlider.background": "#2c313b4d", // --line @ 0.30
  "minimapSlider.hoverBackground": "#2c313b80", // --line @ 0.50
  "minimapSlider.activeBackground": "#3a404bb3", // --line-2 @ 0.70

  // --- floating widgets -----------------------------------------------------
  "editorWidget.background": "#1b1e24", // --surface
  "editorWidget.foreground": "#e4e7ec", // --text
  "editorWidget.border": "#2c313b", // --line
  "editorHoverWidget.background": "#1b1e24", // --surface
  "editorHoverWidget.border": "#2c313b", // --line
  "editorSuggestWidget.background": "#1b1e24", // --surface
  "editorSuggestWidget.border": "#2c313b", // --line
  "editorSuggestWidget.foreground": "#e4e7ec", // --text
  "editorSuggestWidget.selectedBackground": "#22262e", // --surface-2
  "menu.background": "#1b1e24", // --surface
  "menu.foreground": "#949cab", // --text-dim
  "menu.border": "#2c313b", // --line
  "menu.selectionBackground": "#22262e", // --surface-2
  "menu.selectionForeground": "#e4e7ec", // --text
  "list.hoverBackground": "#22262e", // --surface-2
  "input.background": "#14161a", // --bg
  "input.foreground": "#e4e7ec", // --text
  "input.border": "#3a404b", // --line-2

  // --- diagnostics (only JSON produces these) --------------------------------
  "editorError.foreground": "#d9635f", // --err
  "editorWarning.foreground": "#d9a93f", // --warn
  "editorInfo.foreground": "#949cab", // --text-dim
};

/**
 * Define the theme from the fixed palette plus the accent as it is *now*.
 * Monaco takes colour strings, not `var()`, so the accent has to be read and the
 * theme redefined whenever it changes; see `accentThemeColors`.
 */
function defineAccentTheme(): void {
  monaco.editor.defineTheme(THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: { ...BASE_COLORS, ...accentThemeColors() },
  });
  monaco.editor.setTheme(THEME);
}

defineAccentTheme();
// The accent is a setting; the theme above baked in whatever it was at load.
onThemeChange(() => defineAccentTheme());

/** What `PreviewPane.tsx` holds without importing Monaco itself. */
export type PreviewModel = monaco.editor.ITextModel;
export type PreviewEditor = monaco.editor.IStandaloneCodeEditor;
export type PreviewDecorations = monaco.editor.IEditorDecorationsCollection;

/**
 * A model for one file's text, keyed by its path. Ported from Files'
 * `createModel`, including its reuse guard: Monaco refuses to create a second
 * model at a URI that already has one, which would throw mid-swap if a previous
 * model's disposal were ever missed. That can only happen if a caller skips the
 * dispose step `PreviewPane.tsx`'s effect cleanup performs, so the guard is a
 * safety net, not the expected path.
 */
export function createPreviewModel(text: string, path: string, extension: string): PreviewModel {
  const uri = monaco.Uri.file(path);
  const language = languageFor(extension);

  const existing = monaco.editor.getModel(uri);
  if (existing) {
    existing.setValue(text);
    if (language) monaco.editor.setModelLanguage(existing, language);
    return existing;
  }

  return monaco.editor.createModel(text, language, uri);
}

/**
 * The model the editor is mounted over before any file has been focused, and
 * again between a new focus starting to load and its text arriving.
 *
 * Deliberately not `createPreviewModel("", "", "")` — an empty path would give
 * every unfocused pane the same `file:///` URI, and the first real file
 * previewed would collide with it under `createPreviewModel`'s reuse guard.
 * `createModel` with no URI makes an anonymous `inmemory://` model that can
 * never collide with a real path, which is what a placeholder should be.
 */
export function createEmptyPreviewModel(): PreviewModel {
  return monaco.editor.createModel("", "plaintext");
}

/**
 * Mount an editor over an existing model. The model is passed in, never built
 * from a string, so the caller decides its lifetime — see `PreviewPane.tsx`'s
 * disposal-order comment for why that matters.
 *
 * `readOnly` and `domReadOnly` both `true`, always — no path here ever sets
 * either to `false`. `domReadOnly` is the one DiffView's header need not
 * mention (a diff editor has no caret to blink); without it a read-only pane
 * still shows a blinking caret, which reads as "type here" for a pane that
 * refuses every keystroke.
 *
 * Minimap off, matching DiffView rather than Files: this pane sits in the
 * overlay's lower-right region, not a full-width tab, and a minimap is a
 * distraction at that width for a reader glancing at one match.
 */
export function mountPreviewEditor(container: HTMLElement, model: PreviewModel): PreviewEditor {
  return monaco.editor.create(container, {
    model,
    theme: THEME,
    readOnly: true,
    domReadOnly: true,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontFamily: readToken("--mono") || "monospace",
    fontSize: 12,
    renderLineHighlight: "line",
    // A source file's own line breaks are information a preview must not
    // misreport by re-flowing them. Same rule, same value, as Files' editor.
    wordWrap: "off",
  });
}

/** Scroll to and highlight one match, replacing whatever the previous
 *  decoration was. `column` and `length` are 1-based and character-counted the
 *  way `SearchMatch` documents them, which is exactly what `monaco.Range`
 *  expects for a single-line range, so no translation happens here. */
export function revealMatch(
  editor: PreviewEditor,
  match: { line: number; column: number; length: number },
): PreviewDecorations {
  editor.revealLineInCenter(match.line);
  return editor.createDecorationsCollection([
    {
      range: new monaco.Range(match.line, match.column, match.line, match.column + match.length),
      options: {
        className: "preview-pane__match",
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    },
  ]);
}

/** Open at the top — the match-free counterpart to `revealMatch`. */
export function revealTop(editor: PreviewEditor): void {
  editor.setScrollPosition({ scrollTop: 0 });
}

/** One CSS custom property off the root element, trimmed. `""` if unset. */
function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
