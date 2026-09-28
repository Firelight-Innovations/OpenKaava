/**
 * Display data for a cluster's environment — a label, a branch (where one
 * applies), and whether write actions should be refused for it — derived
 * once here rather than re-derived at every place that draws a badge for it
 * (the cluster switcher, the title bar, a future dialog).
 *
 * `environmentOf` reads `Cluster.environment` when it is set, and falls back
 * to the legacy `Cluster.worktree` when it is not — the same precedence
 * `cluster_root` gives on the Rust side (`src-tauri/src/shell_state.rs`),
 * mirrored here so the frontend never disagrees with the backend about
 * which field won. See `bindings.ts`'s `Cluster.environment` doc for why a
 * cluster can carry `environment: undefined` and still have real work to
 * show — a `layout.json` old enough to predate this build's migration, or
 * one this build's own migration declined to guess at.
 */
import type { Cluster, Environment } from "../bindings";

export interface EnvironmentDisplay {
  /** What a badge reads: `wt/feat-x`, `Main`, `vm-1`, `Design`. */
  label: string;
  /** The branch this environment is on, where that concept applies — `null`
   *  for `Main` (no fixed branch to name) and for a `Cloud` session with none
   *  recorded. */
  branch: string | null;
  /** Whether a write action (commit, stage, …) should be refused for a
   *  cluster on this environment. Mirrors `environments::Environment::is_main`
   *  on the Rust side, which is the guard that actually enforces it — this
   *  flag is for drawing the refusal in the UI *before* the backend has to. */
  readOnly: boolean;
}

/**
 * `null` for a cluster with no environment concept at all — a page, or an
 * ordinary cluster nobody has ever pointed at a worktree. Callers draw
 * nothing for `null`, the same way `TitleBar`'s `worktree` segment already
 * drops rather than draws a placeholder for an absent value.
 */
export function environmentOf(cluster: Cluster): EnvironmentDisplay | null {
  const env = cluster.environment;
  if (env) {
    return displayFor(env);
  }

  // Pre-migration fallback: the legacy field a `layout.json` this old still
  // has. `cluster_root`'s own doc on the Rust side spells out why this is
  // read as "some worktree, not read-only" rather than as `Main` — the same
  // reasoning applies to the label shown for it.
  if (cluster.worktree) {
    const branch = cluster.worktree.branch;
    return { label: branch ?? "worktree", branch, readOnly: false };
  }

  return null;
}

function displayFor(env: Environment): EnvironmentDisplay {
  switch (env.kind) {
    case "localWorktree":
      return { label: env.branch, branch: env.branch, readOnly: false };
    case "cloud":
      // No branch recorded is not an error — a cloud session can be mid-setup,
      // with an agent about to create one. The VM id is still a truthful label.
      return { label: env.branch ?? env.vm, branch: env.branch, readOnly: false };
    case "main":
      return { label: "Main", branch: null, readOnly: true };
    case "design":
      return { label: "Design", branch: env.branch, readOnly: false };
  }
}
