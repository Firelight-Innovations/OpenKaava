// Plane CE's own frontend routes — where this app points the child webview,
// not the REST API (`rpc.ts` goes through `/api/v1/` for that). Taken from
// Plane v1.4.2's routing; only what `docs/handoffs/plane-frontend.md` marks
// "confirmed" has been checked against the live instance. A wrong guess here
// still fails safe: `plane_webview::is_plane_url` refuses any host that
// isn't `plane.kaava.internal`, whatever path a caller builds.

/** `OPENKAAVA-PLANE-DESIGN.md` §2/§3, restated as a full origin so every
 * route below can build an absolute URL for `webview-open`/`-navigate`. */
export const PLANE_ORIGIN = "http://plane.kaava.internal:8765";

/** The one workspace this app talks to today (confirmed). */
export const WORKSPACE = "veistra";

/** The workspace's own project list (confirmed). */
export function workspaceUrl(): string {
  return `${PLANE_ORIGIN}/${WORKSPACE}/`;
}

// Unverified: Plane's project home redirects to whichever view a member
// last had open, and this always asks for `/issues/` instead of reading
// that preference back — the simplest route that's still always valid.
export function projectUrl(projectId: string): string {
  return `${PLANE_ORIGIN}/${WORKSPACE}/projects/${projectId}/issues/`;
}

// Unverified: the detail route's shape (modal vs. own page) has changed
// across Plane versions and this PR had no project with issues to check.
// Design rule 4 (§13) bars this app's *own* UI from Plane's nouns; naming
// one here, in a comment about Plane's routes, isn't the same claim.
export function issueUrl(projectId: string, issueId: string): string {
  return `${PLANE_ORIGIN}/${WORKSPACE}/projects/${projectId}/issues/${issueId}/`;
}

/** The frontend's mirror of `plane_webview::is_plane_url` — checked before
 * a call so a bad route fails where it was built, not as an opaque RPC error. */
export function isPlaneOrigin(url: string): boolean {
  try {
    return new URL(url).host === new URL(PLANE_ORIGIN).host;
  } catch {
    return false;
  }
}
