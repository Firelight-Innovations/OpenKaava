/**
 * The source line at the top of the pane, carried across a toggle.
 *
 * Toggling replaces one viewer with another, so neither can hand the other its
 * scroll position directly. The one being left writes the line here and the one
 * arriving takes it. Line numbers are the currency because both sides have them:
 * Monaco natively, and the Markdown renderer by stamping `data-line` on every
 * block it emits.
 */
const lines = new Map<string, number>();

export function rememberTopLine(path: string, line: number): void {
  if (line >= 1) lines.set(path, line);
}

/** The remembered line, once. A second call gets `undefined`. */
export function takeTopLine(path: string): number | undefined {
  const line = lines.get(path);
  lines.delete(path);
  return line;
}

/** The remembered line without consuming it — for a pane that mounts twice. */
export function peekTopLine(path: string): number | undefined {
  return lines.get(path);
}
