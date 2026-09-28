/**
 * Notifies when the shell's theme or accent changes, so a chart can dispose
 * and re-init with fresh tokens — `docs/KAAVA-UX-REWORK.md` §4: "The shell
 * dispatches `kaava:theme-changed` to every app when theme or accent
 * changes."
 *
 * `@openkaava/bridge` has no typed subscription for this yet; the tokens
 * workstream is adding one, probably an `onThemeChanged` export built on its
 * `on(event, cb)`. Until that lands, this listens for the raw `message` event
 * by hand. Kept in its own file so the swap to the bridge's export, once it
 * exists, touches one line here rather than every chart.
 */
export function onThemeChanged(cb: () => void): () => void {
  const listener = (event: MessageEvent): void => {
    const data = event.data as { type?: unknown } | null;
    if (data !== null && typeof data === "object" && data.type === "kaava:theme-changed") cb();
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
