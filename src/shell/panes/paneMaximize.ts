/**
 * The one state transition maximise makes: double-click a tab (or `Esc`) and
 * `maximizedPaneId` becomes this pane, or `null` if it already was.
 *
 * A pure toggle so it can be pinned by a test without mounting `PaneTree` —
 * the hide/show side of maximise (which panes `display: none` while one is
 * maximised) is a rendering concern and stays there, off `paneLeaves` from
 * `contract.ts`; this is only the state.
 */
export function toggleMaximize(current: string | null, paneId: string): string | null {
  return current === paneId ? null : paneId;
}
