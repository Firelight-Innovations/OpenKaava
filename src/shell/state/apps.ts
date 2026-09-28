/**
 * The first-party apps this build ships.
 *
 * Mirrors `src-tauri/src/apps/mod.rs`. Asked for once and never again: the
 * registry is compiled in, so nothing on disk can change the answer while the
 * shell runs, and there is no "re-scan apps" to offer.
 *
 * Starts as an empty array rather than `null`. The stack snapshot's "not loaded
 * yet" against "loaded and empty" buys nothing here: the switcher gains its app
 * tabs a frame later.
 */
import { useEffect, useState } from "react";
import {
  appCall,
  listApps,
  listOpenables,
  listPages,
  onPluginsChanged,
  type AppInfo,
  type CallScope,
  type Openable,
  type PageInfo,
} from "../../bindings";

export type { PageInfo } from "../../bindings";

export function useApps(): AppInfo[] {
  const [apps, setApps] = useState<AppInfo[]>([]);

  useEffect(() => {
    let live = true;
    void listApps()
      .then((result) => live && setApps(result))
      // An app list that fails to load leaves the switcher showing tools only.
      // Reported rather than swallowed: every other path here is infallible, so
      // a failure is worth seeing instead of reading as "this build ships none".
      .catch((err: unknown) => console.error("kaava: could not list apps:", err));

    return () => {
      live = false;
    };
  }, []);

  return apps;
}

/**
 * The pages this build offers — the six buttons on the project rail,
 * including the disabled one. Asked once, like `useApps`: the page table is
 * compiled in. Empty until it answers, which draws the rail empty for a
 * frame.
 */
export function usePages(): PageInfo[] {
  const [pages, setPages] = useState<PageInfo[]>([]);

  useEffect(() => {
    let live = true;
    void listPages()
      .then((result) => live && setPages(result))
      .catch((err: unknown) => console.error("kaava: could not list pages:", err));

    return () => {
      live = false;
    };
  }, []);

  return pages;
}

/**
 * Everything the Apps menu can open: every app, every listed plugin surface,
 * then a terminal.
 *
 * A second hook beside `useApps` rather than a wider version of it, and not
 * redundant with it: `useApps` is *things with a frontend*, which is what
 * `ToolWindow` resolves a mountable address from; this is *things you can open*,
 * and a terminal is one of those without being one of those. `bindings.ts`'s
 * `Openable` has the full reasoning, including what an empty `url` would break.
 *
 * **This one re-asks**, where `useApps` does not: the app registry is compiled
 * in, and the plugin list is directories a person can add to while it runs.
 *
 * Empty until it answers, like `useApps` above.
 */
export function useOpenables(): Openable[] {
  const [openables, setOpenables] = useState<Openable[]>([]);

  useEffect(() => {
    let live = true;

    const refresh = () => {
      void listOpenables()
        .then((result) => live && setOpenables(result))
        // An empty Apps menu looks exactly like a feature nobody wired up, so it
        // is reported rather than swallowed, for the reason `useApps` gives.
        .catch((err: unknown) => console.error("kaava: could not list openables:", err));
    };

    refresh();

    // Subscribed after the fetch is *started*, not after it resolves — the
    // latter leaves a real window in which a change reaches neither.
    const pending = onPluginsChanged(refresh);

    return () => {
      live = false;
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  return openables;
}

/**
 * Relay one app frame's `invoke` to its Rust half.
 *
 * A pass-through to `appCall` today, kept as a named seam rather than inlined:
 * every app call in the shell goes through this one line, which is where a
 * different backend would be reached from. Its rejection shape is `appCall`'s.
 *
 * `scope` says which surface is asking, which decides *which project* the call
 * is answered against now that a project belongs to a cluster. The caller's to
 * supply, not this function's to guess: `ToolWindow` knows the instance from
 * the message's `event.source`, and the title bar's menu items know the cluster
 * their window is showing. Omitting it means "no cluster", which every app
 * already handles — the same state as a cluster nobody has opened anything in.
 */
export function callApp(
  id: string,
  method: string,
  params?: unknown,
  scope?: CallScope,
): Promise<unknown> {
  return appCall(id, method, params, scope);
}
