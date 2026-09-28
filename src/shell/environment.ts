/**
 * Which environment a cluster is working in, and whether two clusters share one.
 *
 * A shared leaf module (STANDARDS.md §1.2): a region may import `contract.ts`
 * and the leaves directly under `src/shell/`, nothing else. `chrome` owns the
 * full environment model (KAAVA-UX-REWORK.md §2) — a cluster bound to a local
 * worktree, a cloud session, or main; this is only the slice the drop-refusal
 * gate needs today, and the integrator reconciles the two if they diverge.
 */
import { clusterRoot, type Cluster } from "./contract";

/**
 * The environment a cluster is bound to, as an opaque id two clusters can be
 * compared by. Today this is exactly `clusterRoot` — the worktree path, or
 * the project folder with no worktree of its own. `null` for a cluster
 * pointed at nothing yet, and for a cloud session, which nothing populates
 * into `Cluster.worktree` yet (KAAVA-UX-REWORK.md §9.2).
 */
export function environmentOf(cluster: Cluster): string | null {
  return clusterRoot(cluster);
}

/**
 * Whether a tab dragged out of `from` may land in `to` — KAAVA-UX-REWORK.md
 * §5: "Tabs can only move between clusters that share an environment."
 *
 * Two clusters with no environment at all are **not** the same one: `null`
 * means "nowhere yet," and an empty cluster is likely about to point at a
 * different project than its neighbour, so refusing rather than allowing is
 * the safer default.
 */
export function sameEnvironment(from: Cluster | null, to: Cluster | null): boolean {
  if (!from || !to) return false;
  const a = environmentOf(from);
  const b = environmentOf(to);
  return a !== null && a === b;
}
