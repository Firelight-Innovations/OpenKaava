/**
 * The terminal band's open state, per cluster — the band is drawn inside the
 * cluster's half of the window, so one value per window is what made pulling it
 * up in `auth` resize `billing`'s too.
 *
 * Its *height* is not here: that one is `Cluster::band_height`, saved with the
 * layout. These two are not, because a restored maximized band would open Veistra
 * with the apps hidden behind a terminal. See `Frame`'s `bottomCollapsed`.
 */

/** How the band stands in one cluster, either side of its normal height. */
export interface BandGeometry {
  /** Shut: the band takes no height and draws nothing. */
  collapsed: boolean;
  /** Pulled past the tool window's floor, taking the whole column. */
  maximized: boolean;
}

/** Where every cluster starts, and what a window with none of them reports. */
export const BAND_SHUT: BandGeometry = { collapsed: true, maximized: false };

/** Every cluster whose band has moved, keyed by id. A record and not a `Map`,
 *  so React sees a new object on every write; ids are never reused within a
 *  session, so a closed cluster's entry cannot be inherited by a later one. */
export type BandGeometryByCluster = Readonly<Record<string, BandGeometry>>;

/** How the band stands in one cluster, or `BAND_SHUT` if it has never moved. */
export function bandGeometry(
  byCluster: BandGeometryByCluster,
  clusterId: string | null,
): BandGeometry {
  if (clusterId === null) return BAND_SHUT;
  return byCluster[clusterId] ?? BAND_SHUT;
}

/**
 * Record part of one cluster's band state, leaving every other cluster's alone.
 *
 * A patch, because the halves are set from different places: a drag reports
 * both, opening the band for a new terminal reports only that it is no longer
 * shut. A window with no cluster gets the map back untouched.
 */
export function withBandGeometry(
  byCluster: BandGeometryByCluster,
  clusterId: string | null,
  patch: Partial<BandGeometry>,
): BandGeometryByCluster {
  if (clusterId === null) return byCluster;
  return {
    ...byCluster,
    [clusterId]: { ...bandGeometry(byCluster, clusterId), ...patch },
  };
}
