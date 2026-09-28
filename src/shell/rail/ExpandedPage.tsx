import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import "./expandedpage.css";

export interface ExpandedPageProps {
  /** The cluster the "← <cluster name>" back button returns to. */
  backLabel: string;
  onBack: () => void;
  title: string;
  subtitle?: string;
  /** Status pills, e.g. "plane-vm running" -- already-built, page-specific. */
  pills?: ReactNode;
  /** Right-aligned actions, e.g. "Open in browser", "Dock beside panes". */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * The expanded page shell: a single `40px` header replacing the cluster
 * row's breadcrumb, then the page's own content filling the rest of the
 * workspace area. `KAAVA-UX-SPEC.md` §1.8 — the title bar and rail persist
 * around this (drawn by `Frame`); panes underneath are never unmounted, only
 * covered.
 *
 * `onBack` is also what `Esc` calls — `WindowRoot`'s keyboard effect owns
 * that binding, not this component, so the same handler serves the click and
 * the key.
 */
export default function ExpandedPage({
  backLabel,
  onBack,
  title,
  subtitle,
  pills,
  actions,
  children,
}: ExpandedPageProps) {
  return (
    <div className="k-expanded-page">
      <header className="k-expanded-page__header">
        <button type="button" className="k-expanded-page__back" onClick={onBack}>
          <ChevronLeft size={14} strokeWidth={1.6} aria-hidden />
          <span>{backLabel}</span>
          <span className="k-expanded-page__esc">Esc</span>
        </button>
        <span className="k-expanded-page__title">{title}</span>
        {subtitle && <span className="k-expanded-page__subtitle">{subtitle}</span>}
        {pills}
        {actions && <span className="k-expanded-page__actions">{actions}</span>}
      </header>
      <div className="k-expanded-page__body">{children}</div>
    </div>
  );
}
