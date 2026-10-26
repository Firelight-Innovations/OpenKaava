/**
 * The tutorial list, and what has been finished.
 *
 * One call, and every mutation answers with the whole catalog back — so there
 * is no local model of progress to keep in step with the store. Marking a
 * tutorial done is a round trip whose reply *is* the new state, which costs a
 * frame on a click nobody does twice a second and removes the class of bug
 * where the tick and the count disagree.
 *
 * Declared here rather than imported from the orchestrator's `src/bindings.ts`,
 * for the reason every app declares its own: an app's only coupling to its host
 * is `@veistra/bridge` and the shape of what crosses it. Mirrors
 * `src-tauri/src/apps/tutorial.rs`.
 */
import { useCallback, useEffect, useState } from "react";
import { VeistraRpcError, invoke } from "@veistra/bridge";

export interface Section {
  id: string;
  title: string;
  description: string;
  order: number;
}

export interface Tutorial {
  id: string;
  section: string;
  title: string;
  blurb: string;
  minutes: number;
  /** The tutorial this one reads best after, or `null`. Nothing is locked. */
  after: string | null;
}

export interface Catalog {
  sections: Section[];
  tutorials: Tutorial[];
  completed: string[];
  featured: string[];
}

export interface CatalogSession {
  catalog: Catalog | null;
  error: string | null;
  /** Whether the first answer has landed, either way it went. */
  settled: boolean;
  isDone: (id: string) => boolean;
  setDone: (id: string, done: boolean) => void;
  resetAll: () => void;
}

export function useCatalog(): CatalogSession {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);

  const land = useCallback((next: Catalog) => {
    setCatalog(next);
    setError(null);
    setSettled(true);
  }, []);

  const fail = useCallback((e: unknown) => {
    setError(describe(e));
    setSettled(true);
  }, []);

  useEffect(() => {
    let live = true;

    void invoke<Catalog>("tutorial/catalog")
      .then((next) => {
        if (live) land(next);
      })
      .catch((e: unknown) => {
        if (live) fail(e);
      });

    return () => {
      live = false;
    };
  }, [land, fail]);

  const setDone = useCallback(
    (id: string, done: boolean) => {
      void invoke<Catalog>("tutorial/complete", { id, done }).then(land).catch(fail);
    },
    [land, fail],
  );

  const resetAll = useCallback(() => {
    void invoke<Catalog>("tutorial/reset").then(land).catch(fail);
  }, [land, fail]);

  const isDone = useCallback((id: string) => catalog?.completed.includes(id) ?? false, [catalog]);

  return { catalog, error, settled, isDone, setDone, resetAll };
}

/**
 * A `VeistraRpcError` carries the JSON-RPC code its host produced it from, which
 * is the difference between "this build has no such method" and "the call never
 * reached a host at all".
 */
function describe(error: unknown): string {
  if (error instanceof VeistraRpcError) return `[${error.code}] ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
