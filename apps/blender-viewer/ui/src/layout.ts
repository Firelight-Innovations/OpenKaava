/**
 * Below this pane width the footer's secondary actions drop their labels. The
 * full row (export, auto, comments, three send/copy buttons, open) needs about
 * 880px; measured on the pane, not the window, because the viewer lives in
 * panes of any size.
 */
export const COMPACT_FOOTER_BELOW = 920;

export function footerIsCompact(paneWidth: number): boolean {
  return paneWidth > 0 && paneWidth < COMPACT_FOOTER_BELOW;
}
