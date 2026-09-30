/**
 * "Review & merge" — the one worktree action, on the title bar's right beside
 * search. It opens the rail's Git page on its Source Control tab. Below the
 * bar's narrow breakpoint the label drops and only the merge glyph stays (see
 * `titlebar.css`); the accessible name is always the full text.
 */
import { GitMerge } from "lucide-react";

export default function ReviewMergeButton({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      className="titlebar__action"
      aria-label="Review & merge"
      title="Review & merge"
      onClick={onClick}
    >
      <GitMerge size={14} strokeWidth={1.5} aria-hidden className="titlebar__action-icon" />
      <span className="titlebar__action-label">Review &amp; merge</span>
    </button>
  );
}
