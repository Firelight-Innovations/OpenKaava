import type { ReactNode } from "react";
import { X } from "lucide-react";
import "./dockedpage.css";

export interface DockedPageProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * The docked page's own content: a header (title, subtitle, close) and a
 * body, filling whatever box `Frame` gives `slots.projectPage`.
 *
 * Width, the resize handle and the aside's background/border/radius all
 * belong to `Frame` (`frame.css`'s `.frame__page` / `.frame__pagehandle`,
 * driven by `projectPageWidth`/`onProjectPageWidthChange`) for the same
 * reason `slots.secondaryPanel` carries none of those either: the thing
 * being resized is the split, and `Frame` is the one place that already
 * owns a split's geometry. This component only ever fills the box it is
 * handed.
 */
export default function DockedPage({ title, subtitle, onClose, children }: DockedPageProps) {
  return (
    <div className="k-docked-page" aria-label={title}>
      <header className="k-docked-page__header">
        <span className="k-docked-page__title">{title}</span>
        {subtitle && <span className="k-docked-page__subtitle">{subtitle}</span>}
        <button
          type="button"
          className="k-docked-page__close"
          aria-label={`Close ${title}`}
          onClick={onClose}
        >
          <X size={14} strokeWidth={1.6} aria-hidden />
        </button>
      </header>
      <div className="k-docked-page__body">{children}</div>
    </div>
  );
}
