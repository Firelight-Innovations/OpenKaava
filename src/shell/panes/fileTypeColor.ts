/**
 * The tab strip's file-type colour square (KAAVA-UX-SPEC.md §1.6): a solid
 * colour keyed by extension, `11-12px`, `radius 3px`, next to the tab label.
 *
 * A pure function of the file name so it is trivially testable and so
 * `PaneTabStrip` never has to know the mapping itself. Returns a CSS custom
 * property reference (`"var(--syn-type)"`), never a hex — every colour in
 * this codebase is a token (see the rework brief), and a square painted from
 * a raw string here would be the one place that rule quietly broke.
 *
 * The board only documents four extensions (`.gd`, `.rs`, `.tscn`, and
 * `.toml`/`.md` sharing "greys"); everything else falls back to the same
 * grey rather than a guess at a colour no board shows.
 */
export function fileTypeColor(name: string): string {
  const ext = extensionOf(name);
  switch (ext) {
    case "gd":
      return "var(--syn-type)";
    case "rs":
      return "var(--syn-rust)";
    case "tscn":
      return "var(--info)";
    case "toml":
    case "md":
      return "var(--txt-disabled)";
    default:
      return "var(--txt-disabled)";
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}
