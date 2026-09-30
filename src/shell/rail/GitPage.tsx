import type { ReactNode } from "react";
import "./gitpage.css";

/**
 * The Git page's body: Source Control and GitHub as two tabs.
 *
 * This is what the standalone secondary panel used to draw beside the tool
 * window. It lives on the rail now, so the right side of the window has one
 * sidebar rather than two. `DockedPage` or `ExpandedPage` supplies the header
 * and the box; this fills the body with a tab row and the two views.
 *
 * Both views arrive as slots. `rail` is a region and may not import the
 * `worktree` or `github` regions, so `WindowRoot` builds them and hands them
 * in, the same wiring `SecondaryPanel` had.
 */

/** Which of the page's two tabs is showing. A union rather than a boolean so a
 *  third tab is a case to handle rather than a rewrite. */
export type GitPageView = "worktree" | "github";

const VIEW_LABEL: Record<GitPageView, string> = {
  worktree: "Source Control",
  github: "GitHub",
};

export interface GitPageProps {
  /** Undefined leaves the tab out, rather than drawing a tab that shows nothing. */
  worktreeView?: ReactNode;
  githubView?: ReactNode;
  view: GitPageView;
  onSelectView: (view: GitPageView) => void;
}

export default function GitPage({ worktreeView, githubView, view, onSelectView }: GitPageProps) {
  // Only the views this window was actually handed. A tab that switches to
  // nothing is worse than one title and no switcher.
  const available: GitPageView[] = [
    ...(worktreeView ? (["worktree"] as const) : []),
    ...(githubView ? (["github"] as const) : []),
  ];
  const active = available.includes(view) ? view : (available[0] ?? view);

  return (
    <div className="k-git-page">
      <div className="k-git-page__tabs" role="tablist" aria-label="Git view">
        {available.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={candidate === active}
            className="k-git-page__tab"
            data-active={candidate === active ? "" : undefined}
            onClick={() => onSelectView(candidate)}
          >
            {VIEW_LABEL[candidate]}
          </button>
        ))}
      </div>

      {/* Both mounted, one hidden. The GitHub view holds a typed filter and a
          list fetched over the network, and unmounting it on every switch
          would discard both and spend a GitHub request coming back. */}
      <div className="k-git-page__body" role="tabpanel" hidden={active !== "worktree"}>
        {worktreeView ?? null}
      </div>
      <div className="k-git-page__body" role="tabpanel" hidden={active !== "github"}>
        {githubView ?? null}
      </div>
    </div>
  );
}
