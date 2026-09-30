/**
 * Which files have a rendered form, and what to call it.
 *
 * Extension only, for the reason `viewer/registry.ts` gives: a name is the whole
 * input this app admits. The answer decides three things and nothing else — the
 * Preview button appears, Ctrl+Shift+V does something, and Monaco gets the
 * keybinding. Everything downstream (which component draws it) is in
 * `PreviewPane`.
 */

export type PreviewKind = "markdown" | "mermaid" | "svg" | "html";

const KIND_BY_EXTENSION: Record<string, PreviewKind> = {
  md: "markdown",
  markdown: "markdown",
  mmd: "mermaid",
  mermaid: "mermaid",
  svg: "svg",
  html: "html",
  htm: "html",
};

/** The rendered form of a file with this extension, or `null` when it has none. */
export function previewKindFor(ext: string): PreviewKind | null {
  return KIND_BY_EXTENSION[ext.toLowerCase()] ?? null;
}

/**
 * The registry id of the full-pane viewer for a kind.
 *
 * `svg` and `mermaid` are the same ids the registry already routes those
 * extensions to. `markdown` and `html` are opt-in: they exist as viewers but the
 * registry never picks them, because a `.md` file opens as source, like VS Code.
 */
export const VIEWER_ID_BY_KIND: Record<PreviewKind, string> = {
  markdown: "markdown",
  mermaid: "mermaid",
  svg: "svg",
  html: "html",
};

/** What the affordance says, per kind. */
export const KIND_LABEL: Record<PreviewKind, string> = {
  markdown: "Markdown",
  mermaid: "Diagram",
  svg: "SVG",
  html: "HTML",
};

/** The two shortcuts, as the chips a tooltip draws. VS Code's own. */
export const PREVIEW_SHORTCUT = "Ctrl+Shift+V";
export const PREVIEW_SIDE_SHORTCUT = "Ctrl+K V";
