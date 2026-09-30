/**
 * What the cluster bar's `+` (and Ctrl+Shift+N) should do next.
 *
 * Every new cluster needs a project and an environment, and the New Cluster
 * dialog is what supplies the environment — so with no project set, the project
 * has to be chosen first.
 *
 *  - `new-cluster`: a project is set; open the New Cluster dialog.
 *  - `pick-project`: no project, but there is an active cluster for the choice
 *    to land in; open Switch project, then New Cluster once it resolves.
 *  - `bare`: no project and no cluster at all (a window whose last cluster just
 *    closed). Nothing can receive a project, so make a plain cluster to hold one.
 */
export type AddClusterStep = "new-cluster" | "pick-project" | "bare";

export function nextAddClusterStep(hasProject: boolean, hasActiveCluster: boolean): AddClusterStep {
  if (hasProject) return "new-cluster";
  return hasActiveCluster ? "pick-project" : "bare";
}
