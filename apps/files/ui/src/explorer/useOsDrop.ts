/**
 * Files dragged in from the operating system, copied into the folder they land on.
 *
 * The shell sends `files:os-drag` messages (over / leave / drop) with coordinates in this
 * frame. A drop on a folder row goes into that folder, on a file row into its folder, and
 * on empty space into the project root. Nothing is ever overwritten; a name already taken
 * is reported. A read-only checkout refuses before calling anything.
 */
import { useEffect, useRef, useState } from "react";
import { on } from "@openkaava/bridge";
import { describe, importFiles, type Root } from "../rpc";
import { dropFolderAt, importMessage, READ_ONLY_DROP } from "./osDrop";

type Phase =
  | { phase: "over"; x: number; y: number }
  | { phase: "leave" }
  | { phase: "drop"; x: number; y: number; paths: string[] };

export function useOsDrop({
  root,
  onImported,
  onProblem,
}: {
  root: Root | null;
  /** Something was copied: re-list the tree and the git badges. */
  onImported: () => void;
  /** Words for the user: a conflict, a failure or the read-only refusal. */
  onProblem: (message: string) => void;
}): { target: string | null } {
  const [target, setTarget] = useState<string | null>(null);
  // The handler is subscribed once per root; the callbacks change identity every render.
  const latest = useRef({ onImported, onProblem });
  latest.current = { onImported, onProblem };
  const rootPath = root?.path ?? null;
  const readOnly = root?.readOnly ?? false;

  useEffect(
    () =>
      on("files:os-drag", (payload) => {
        const drag = payload as Phase | null;
        if (!drag || rootPath === null) return;
        if (drag.phase === "leave") return setTarget(null);

        const dest = dropFolderAt(document.elementFromPoint(drag.x, drag.y), rootPath);
        if (drag.phase === "over") return setTarget(readOnly ? null : dest);

        setTarget(null);
        if (drag.paths.length === 0) return;
        if (readOnly) return latest.current.onProblem(READ_ONLY_DROP);
        void importFiles(dest, drag.paths)
          .then((done) => {
            if (done.copied.length > 0) latest.current.onImported();
            const message = importMessage(dest, rootPath, done);
            if (message) latest.current.onProblem(message);
          })
          .catch((err: unknown) => latest.current.onProblem(describe("files/import", err)));
      }),
    [rootPath, readOnly],
  );

  return { target };
}
