import type { ComponentType } from "react";
import type { PageInfo } from "../contract";
import { Receipt, Robot } from "../../ui/Icon";

/**
 * The glyph for each page's `icon` key. The key comes from `pages.rs`, so a page
 * is declared in Rust while its icon set stays here. A key with no entry draws
 * the chip with its label and no glyph, rather than as an empty square.
 */
const PAGE_ICONS: Record<string, ComponentType<{ size?: number; className?: string }>> = {
  robot: Robot,
  receipt: Receipt,
};

/**
 * The page chips, at the left of the cluster bar.
 *
 * A page is a cluster kind rather than a cluster: one per page per window, one
 * pane, one app, and never closed, renamed or dragged. So a chip has none of a
 * cluster chip's furniture: no count, no ×, no rename, no drag handle, and no
 * members expanding beside it.
 *
 * Each chip is its icon at rest. It widens to icon and label on hover, on
 * keyboard focus, and while its page is the one on screen. The widening is CSS
 * (`switcher.css`, `.switcher__page-label`), not framer: it is a hover, there is
 * no React render to hang a layout animation on, and the label only grows in
 * place — nothing in this scroll row travels sideways.
 *
 * The label is always in the DOM, clipped to nothing at rest, which is what
 * lets it animate; `aria-label` and `title` carry the name for the icon-only state.
 */
export default function PageChips({
  pages,
  activePageId,
  onSelect,
}: {
  pages: PageInfo[];
  /** The page on screen, or `null` while a real cluster (or nothing) is. */
  activePageId: string | null;
  onSelect: (pageId: string) => void;
}) {
  if (pages.length === 0) return null;

  return (
    <div className="switcher__pages" role="group" aria-label="Pages">
      {pages.map((page) => {
        const active = page.id === activePageId;
        const Glyph = PAGE_ICONS[page.icon];
        return (
          <button
            key={page.id}
            type="button"
            className={active ? "switcher__page switcher__page--active" : "switcher__page"}
            // Read by the tests, and by anyone inspecting the DOM: whether the
            // label is open for a reason other than the pointer being over it.
            data-expanded={active}
            aria-pressed={active}
            aria-label={page.name}
            title={page.name}
            onClick={() => onSelect(page.id)}
          >
            {Glyph && <Glyph size={14} className="switcher__page-icon" />}
            <span className="switcher__page-label" aria-hidden="true">
              <span className="switcher__page-text">
                <span className="switcher__page-name">{page.name}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
