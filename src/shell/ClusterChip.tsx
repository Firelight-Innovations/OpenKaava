/**
 * The cluster's mark: its initials, or the emoji the user picked for it, in the
 * same box either way. The strip's badge, the switcher's rows and the picker's
 * preview all draw this, so a chosen icon shows up everywhere the initials did.
 */
import type { Cluster } from "../bindings";
import { chipText, iconColorOf } from "./clusterIcon";
import "./clusterIcon.css";

export interface ClusterChipProps {
  cluster: Pick<Cluster, "name" | "icon">;
  /** Overrides the cluster's own icon, for the picker's live preview and its suggestions. */
  icon?: Cluster["icon"];
  className?: string;
}

export default function ClusterChip({ cluster, icon, className }: ClusterChipProps) {
  const shown = { name: cluster.name, icon: icon === undefined ? cluster.icon : icon };
  const emoji = (shown.icon?.emoji.trim() ?? "") !== "";
  return (
    <span
      className={className ? `cluster-chip ${className}` : "cluster-chip"}
      data-kind={emoji ? "emoji" : "initials"}
      data-icon-color={iconColorOf(shown.icon)}
      aria-hidden="true"
    >
      {chipText(shown)}
    </span>
  );
}
