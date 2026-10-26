import {
  Bot,
  Brain,
  GitBranch,
  Kanban,
  Package,
  Receipt,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { PageInfo } from "../../bindings";
import "./rail.css";

/**
 * `pages::Page::icon` keys to their Lucide component. `VEISTRA-UX-SPEC.md`
 * §1.7: 16px, `stroke-width 1.4`. Kept in step with `pages.rs`'s `PAGES`
 * table by hand — seven rows, so a `find`-and-fall-through would buy nothing a
 * missing-icon console warning below does not already catch.
 */
const PAGE_ICONS: Record<string, LucideIcon> = {
  "git-branch": GitBranch,
  kanban: Kanban,
  bot: Bot,
  brain: Brain,
  receipt: Receipt,
  package: Package,
  sparkles: Sparkles,
};

/**
 * A rail button's 7px notch dot, keyed by page id — the colour per
 * `VEISTRA-UX-REWORK.md` §4's table, or absent for no dot at all. `WindowRoot`
 * computes this (it is the one place that can see every page's live data);
 * `Rail` only draws whatever colour it is handed.
 */
/**
 * Pages that open from somewhere other than the rail. Agents has a button in the
 * title bar and one in the agent tab, and Git opens from the status bar, so
 * neither is drawn here as well.
 */
const OFF_THE_RAIL: ReadonlySet<string> = new Set(["sessions", "git"]);

export type RailDots = Partial<Record<string, string>>;

export interface RailProps {
  /** In rail order, as `pages::rail()` returns it. A disabled page is in the list but is not drawn. */
  pages: PageInfo[];
  activePageId: string | null;
  dots?: RailDots;
  onSelect: (pageId: string) => void;
}

/**
 * The 44px project-page rail at the window's right edge — one 36×36 button
 * per page, `VEISTRA-UX-REWORK.md` §4's fixed order. Purely presentational:
 * which page is active, which is disabled and what each dot's colour is all
 * come in as props, so this component has nothing backend-shaped to know.
 */
export default function Rail({ pages, activePageId, dots, onSelect }: RailProps) {
  const shown = pages.filter((page) => !page.disabled && !OFF_THE_RAIL.has(page.id));
  if (shown.length === 0) return null;
  return (
    <nav className="k-rail" aria-label="Project pages">
      {shown.map((page) => {
        const Icon = PAGE_ICONS[page.icon];
        const active = page.id === activePageId;
        const dot = dots?.[page.id];
        return (
          <button
            key={page.id}
            type="button"
            className="k-rail__btn"
            data-page-id={page.id}
            data-active={active ? "" : undefined}
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
