/**
 * The exported `.glb` as React state. It is fetched again only when the export
 * it belongs to changes (`exportedAt`), not on every state poll, so the view the
 * person is orbiting and any markup on it are left alone.
 */
import { useCallback, useEffect, useState } from "react";
import { fetchGlb, type GlbState } from "./preview";
import { getGlb } from "./rpc";

export function useGlb(blend: string | null, hasModel: boolean, exportedAt: number | undefined) {
  const [state, setState] = useState<GlbState>({ kind: "none" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!blend || !hasModel) {
      setState({ kind: "none" });
      return;
    }
    let live = true;
    setState({ kind: "loading" });
    void fetchGlb(() => getGlb(blend)).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [blend, hasModel, exportedAt, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
