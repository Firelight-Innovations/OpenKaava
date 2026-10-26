/**
 * Where a tool's iframe points.
 *
 * Mirrors `src-tauri/src/tool_frontend.rs`. In development this resolves to the
 * tool's own Vite server, so its hot reload works inside the real shell; in a
 * release build it resolves to the tool's built bundle on the `veistra-tool://`
 * scheme. The frontend never constructs either URL — it asks and mounts what it
 * is given.
 *
 * Resolution is per-tool and on demand rather than part of the stack snapshot,
 * because both answers can change while the shell is running: a dev server can
 * be started or stopped, and a checkout can be built.
 */
import { useEffect, useState } from "react";
import { toolFrontend, type ToolFrontend } from "../../bindings";

export type { ToolFrontend } from "../../bindings";

/**
 * Resolve one tool's frontend.
 *
 * `null` while the answer is in flight — the tool window shows its boot state
 * for that, not an error.
 */
export function useToolFrontend(toolId: string | null): ToolFrontend | null {
  const [frontend, setFrontend] = useState<ToolFrontend | null>(null);

  useEffect(() => {
    setFrontend(null);
    if (!toolId) return;

    let live = true;
    void toolFrontend(toolId)
      .then((f) => live && setFrontend(f))
      .catch((err) => live && setFrontend({ state: "unavailable", reason: String(err) }));

    return () => {
      live = false;
    };
  }, [toolId]);

  return frontend;
}
