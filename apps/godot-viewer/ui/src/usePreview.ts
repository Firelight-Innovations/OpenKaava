/**
 * The 3D preview of the chosen scene, as React state: off, loading (with what
 * the export is doing), ready, or failed (with why). Asking is idempotent and
 * cheap for an unchanged scene, so it is asked again whenever the scene might
 * have changed, and a scene that has not changed keeps the view the person is
 * looking at, camera and markup included.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "../../../shared/godot";
import { loadPreview, PreviewFailure, type LoadedPreview } from "./preview";
import { previewBytes, previewGlb } from "./rpc";

export type PreviewState =
  | { kind: "off" }
  | { kind: "loading"; phase: string }
  | { kind: "ready"; data: LoadedPreview }
  | { kind: "failed"; message: string; output: string[] };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function usePreview(scene: string | undefined, enabled: boolean) {
  const [state, setState] = useState<PreviewState>({ kind: "off" });
  const abort = useRef<AbortController | null>(null);
  const ready = useRef(false);

  useEffect(() => {
    ready.current = state.kind === "ready";
  }, [state]);

  /**
   * `force` exports again even if nothing changed. `quiet` is a re-check of a
   * view already on screen: it shows no loading state, and swaps the glb only
   * if the backend produced a new one.
   */
  const load = useCallback(
    (force: boolean, quiet: boolean) => {
      if (!scene) return;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      if (!(quiet && ready.current)) setState({ kind: "loading", phase: "starting" });
      loadPreview(
        {
          request: (f) => previewGlb(scene, f),
          bytes: () => previewBytes(scene),
          sleep,
        },
        {
          force,
          signal: controller.signal,
          onPhase: (phase) =>
            setState((s) => (s.kind === "ready" ? s : { kind: "loading", phase })),
        },
      )
        .then((data) => {
          if (controller.signal.aborted) return;
          setState((s) =>
            s.kind === "ready" && s.data.exportedAt === data.exportedAt && s.data.path === data.path
              ? s
              : { kind: "ready", data },
          );
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          setState({
            kind: "failed",
            message: e instanceof PreviewFailure ? e.message : errorText(e),
            output: e instanceof PreviewFailure ? e.output : [],
          });
        });
    },
    [scene],
  );

  useEffect(() => {
    if (!enabled || !scene) {
      abort.current?.abort();
      return;
    }
    load(false, false);
    return () => abort.current?.abort();
  }, [enabled, scene, load]);

  return { state: enabled && scene ? state : ({ kind: "off" } as PreviewState), load };
}
