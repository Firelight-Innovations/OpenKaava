import { Bot, Brain, GitBranch, Kanban, Package, Receipt, type LucideIcon } from "lucide-react";
import type { PageInfo } from "../../bindings";
import "./rail.css";

/**
 * `pages::Page::icon` keys to their Lucide component. `KAAVA-UX-SPEC.md`
 * §1.7: 16px, `stroke-width 1.4`. Kept in step with `pages.rs`'s `PAGES`
 * table by hand — six rows, so a `find`-and-fall-through would buy nothing a
 * missing-icon console warning below does not already catch.
 */
const PAGE_ICONS: Record<string, LucideIcon> = {
  "git-branch": GitBranch,
  kanban: Kanban,
  bot: Bot,
  brain: Brain,
  receipt: Receipt,
  package: Package,
};

/**
 * A rail button's 7px notch dot, keyed by page id — the colour per
 * `KAAVA-UX-REWORK.md` §4's table, or absent for no dot at all. `WindowRoot`
 * computes this (it is the one place that can see every page's live data);
 * `Rail` only draws whatever colour it is handed.
 */
export type RailDots = Partial<Record<string, string>>;

export interface RailProps {
  /** In rail order, as `pages::rail()` returns it -- including the disabled row. */
  pages: PageInfo[];
  activePageId: string | null;
  dots?: RailDots;
  onSelect: (pageId: string) => void;
}

/**
 * The 44px project-page rail at the window's right edge — one 36×36 button
 * per page, `KAAVA-UX-REWORK.md` §4's fixed order. Purely presentational:
 * which page is active, which is disabled and what each dot's colour is all
 * come in as props, so this component has nothing backend-shaped to know.
 */
export default function Rail({ pages, activePageId, dots, onSelect }: RailProps) {
  return (
    <nav className="k-rail" aria-label="Project pages">
      {pages.map((page) => {
        const Icon = PAGE_ICONS[page.icon];
        const active = page.id === activePageId;
        const dot = dots?.[page.id];
        return (
          <button
            key={page.id}
            type="button"
            className="k-rail__btn"
            data-active={active ? "" : undefined}
            disabled={page.disabled}
            aria-pressed={active}
            aria-label={page.name}
            title={`${page.name} · Alt ${page.key}`}
            onClick={() => onSelect(page.id)}
          >
            {Icon && <Icon size={16} strokeWidth={1.4} aria-hidden />}
            {dot && <span className="k-rail__dot" style={{ background: dot }} />}
          </button>
        );
      })}
    </nav>
  );
}
