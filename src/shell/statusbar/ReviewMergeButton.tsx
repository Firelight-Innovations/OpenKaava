/**
 * "Review & merge" — the one worktree action, on the status bar's right beside
 * the GitHub indicator. It opens the rail's Git page on its Source Control tab.
 * Below the status bar's narrow breakpoint the label drops and only the merge
 * glyph stays (see `statusbar.css`); the accessible name is always the full text.
 */
import { GitMerge } from "lucide-react";

export default function ReviewMergeButton({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      className="statusbar__review"
      aria-label="Review & merge"
      title="Review & merge"
      onClick={onClick}
    >
      <GitMerge size={12} strokeWidth={1.5} aria-hidden className="statusbar__review-icon" />
      <span className="statusbar__review-label">Review &amp; merge</span>
    </button>
  );
}
