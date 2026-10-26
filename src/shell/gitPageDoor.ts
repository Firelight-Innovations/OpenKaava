/**
 * What a control that names a Git view does to the rail's Git page.
 *
 * The rail's own door onto the page, `onSelectPage("git")`, toggles. A control
 * that asks for a view must not shut the page it asked to see, so it goes
 * through that door only while the page is shut, then picks its view. `null`
 * is the status bar's toggle, pressed on the view already showing: it shuts
 * the Git page, and leaves any other page alone.
 *
 * The status bar stays live under the screens that cover the page (Settings,
 * the app library, keyboard shortcuts). A control pressed there takes the
 * screen down first, so the page it opens can be seen. While one is up, no
 * view counts as showing: a page you cannot see is not one to shut.
 *
 * Directly under `src/shell/` beside `WindowRoot.tsx`, its one caller, so it
 * can be tested without mounting the window.
 */
export function showGitView<V>(
  view: V | null,
  open: boolean,
  door: { uncover(): void; open(): void; close(): void; setView(view: V): void },
): void {
  door.uncover();
  if (view === null) {
    if (open) door.close();
    return;
  }
  if (!open) door.open();
  door.setView(view);
}

/** The view the status bar draws pressed: the Git page's, while it is open and
 *  nothing covers it, else `null`. */
export function gitViewShowing<V>(pageId: string | undefined, covered: boolean, view: V): V | null {
  return pageId === "git" && !covered ? view : null;
}
