/**
 * What every cluster surface asks the same questions of the cluster list.
 *
 * The title bar's dropdown, the rail's strip and the keyboard (Ctrl+1…9,
 * Ctrl+Tab) all present the same clusters, so they have to agree on the order,
 * on what a cluster is called at a glance, and on which ones want attention.
 * Each of those is answered here, once, so the three cannot drift into showing
 * three different orders — Ctrl+2 has to mean the second thing on screen.
 */
import type { Cluster, MenuItem } from "./contract";
import { environmentOf, ENVIRONMENT_LABEL } from "./environment";

/**
 * The order clusters are shown and numbered in: the pinned Design canvas first
 * (§1.3), everything else in the order the window holds them.
 *
 * The Design cluster is found the way `environment.ts` finds it everywhere else,
 * by its environment kind, rather than by `Cluster.pinned` — there is one
 * derivation, and this is not a second one.
 */
export function orderClusters(clusters: readonly Cluster[]): Cluster[] {
  const design = clusters.find((c) => environmentOf(c).kind === "design");
  if (!design) return [...clusters];
  return [design, ...clusters.filter((c) => c.id !== design.id)];
}

/**
 * The cluster one step from the active one, wrapping at both ends. `null` when
 * there is nothing to move to: no clusters, or only one.
 *
 * With no active cluster (a window that is between them) forward lands on the
 * first and backward on the last, which is where a cycle that started from
 * "nowhere" would go either way.
 */
export function cycleTarget(
  ordered: readonly Cluster[],
  activeId: string | null,
  step: 1 | -1,
): string | null {
  if (ordered.length === 0) return null;
  const at = ordered.findIndex((c) => c.id === activeId);
  if (at < 0) return (step === 1 ? ordered[0] : ordered[ordered.length - 1]).id;
  if (ordered.length === 1) return null;
  return ordered[(at + step + ordered.length) % ordered.length].id;
}

/** The last path segment, for either separator. */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

/** A cluster's branch as a person reads it: the branch, else the kind's word. */
export function branchLabel(cluster: Cluster): string {
  const env = environmentOf(cluster);
  return env.branch ?? (env.kind === "main" ? "main" : ENVIRONMENT_LABEL[env.kind]);
}

/** "project · branch" — the strip badge's tooltip. */
export function clusterTooltip(cluster: Cluster): string {
  const project = cluster.project ? folderName(cluster.project) : "no project";
  const base = `${project} · ${branchLabel(cluster)}`;
  return cluster.environmentMissing === true ? `${base} (worktree folder missing)` : base;
}

/**
 * Two letters to stand for a cluster in a 28px badge. Word starts when the name
 * has several words (`godot-port` is GP), else its first two characters
 * (`auth` is AU), upper-cased. Never empty: a nameless cluster reads as `?`.
 */
export function monogram(name: string): string {
  const words = name.split(/[\s\-_./\\]+/).filter((w) => w !== "");
  if (words.length === 0) return "?";
  const letters =
    words.length >= 2 ? words[0][0] + words[1][0] : Array.from(words[0]).slice(0, 2).join("");
  return letters.toUpperCase();
}

/** The subset of a terminal session the activity dot reads. */
export interface ClusterTerminal {
  clusterId: string;
  agentFinished: boolean;
}

/**
 * Whether a cluster the user is *not* looking at has something waiting: an agent
 * that finished in one of its terminals. This is the only per-cluster activity
 * the shell already tracks (`TerminalSessionState.agentFinished`); a busy or
 * running signal would need new backend state, so there is deliberately no
 * second colour here. The active cluster never shows one — its own band already
 * does.
 */
export function needsAttention(
  clusterId: string,
  activeId: string | null,
  terminals: readonly ClusterTerminal[],
): boolean {
  if (clusterId === activeId) return false;
  return terminals.some((t) => t.clusterId === clusterId && t.agentFinished);
}

/** What a cluster's context menu can do; every row maps to a handler `WindowRoot` owns. */
export interface ClusterMenuActions {
  /** Switch to it. The rail's own click also does this, and on the active one toggles Home. */
  onSelect: (clusterId: string) => void;
  /** Rename, taking the new name. Rejects with a message to show, like `MenuPrompt.onSubmit`. */
  onRename: (clusterId: string, name: string) => Promise<void>;
  onClose: (clusterId: string) => void;
  /** Open the icon picker for it. Optional so a surface with no picker simply omits the row. */
  onChangeIcon?: (clusterId: string) => void;
}

/**
 * The per-cluster right-click menu: the actions the old tab carried (switch,
 * rename by double-click, the × close button), given rows instead of gestures.
 */
export function clusterMenuItems(cluster: Cluster, actions: ClusterMenuActions): MenuItem[] {
  return [
    { label: "Switch to cluster", onSelect: () => actions.onSelect(cluster.id) },
    {
      label: "Rename…",
      prompt: {
        label: `Rename ${cluster.name}`,
        initialValue: cluster.name,
        confirmLabel: "Rename",
        onSubmit: async (value: string) => {
          const next = value.trim();
          if (next === "") throw new Error("A cluster needs a name.");
          if (next !== cluster.name) await actions.onRename(cluster.id, next);
        },
      },
    },
    ...(actions.onChangeIcon
      ? [
          {
            label: "Change icon…",
            onSelect: () => actions.onChangeIcon?.(cluster.id),
          },
        ]
      : []),
    {
      label: "Close cluster",
      separatorBefore: true,
      onSelect: () => actions.onClose(cluster.id),
    },
  ];
}
