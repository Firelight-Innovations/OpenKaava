/**
 * The responsive rule, measured.
 *
 * "Below roughly 1180px [the inline menu block and the centred title] collide
 * — collapse the six menu items into a single hamburger button." The spec
 * calls for `matchMedia` with a listener rather than a `ResizeObserver` on the
 * bar, so the collapse tracks the *window's* width — the thing the rule is
 * actually about — instead of the bar's, which would also change for reasons
 * that have nothing to do with the collision (a panel resize, for instance).
 */
import { useEffect, useState } from "react";

const QUERY = "(max-width: 1179px)";

export function useNarrowTitlebar(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(QUERY).matches);

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return narrow;
}
