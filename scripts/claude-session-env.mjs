/**
 * Claude Code's session markers, and a way to drop them from an environment.
 *
 * Mirrors `CLAUDE_SESSION_MARKERS` in `src-tauri/src/pty.rs`; the backend strips
 * them from every terminal it spawns, and `pnpm ui launch` strips them before the
 * app starts so the app never holds them at all. A `claude` run in an OpenKaava
 * terminal that sees `CLAUDE_CODE_CHILD_SESSION` believes it is nested, turns
 * transcript saving off, and `/resume` cannot find the session.
 *
 * User configuration (`ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR`) is not here.
 */

export const CLAUDE_SESSION_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_CODE_TERMINAL_MCP_TOOLS",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_PID",
];

/** A copy of `env` without the markers; names compare case-insensitively, as on Windows. */
export function withoutSessionMarkers(env) {
  const markers = new Set(CLAUDE_SESSION_MARKERS);
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !markers.has(name.toUpperCase())),
  );
}
