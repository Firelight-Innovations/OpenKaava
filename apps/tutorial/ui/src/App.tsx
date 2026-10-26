/**
 * Tutorials — the app that explains the rest of them.
 *
 * Two halves that never talk to the machine. The **catalog** comes from
 * `src-tauri/src/apps/tutorial.rs`, because Home draws the same list and a
 * second copy of it there would be a second place to add a tutorial. The
 * **prose** is `content/`, in this repo's own frontend, because it is a view —
 * `docs/tutorials.md` §2 has the whole of that argument.
 *
 * The seam between them is an id. A catalog entry with no body in `content/`
 * renders an honest "not written yet" panel rather than an error, which is the
 * same thing a genuinely unwritten tutorial should show — so the two halves can
 * be edited in either order, and the failure mode of getting it wrong is a
 * missing page rather than a broken app.
 *
 * Nothing here is cluster-scoped. `tutorial::call` ignores its `CallContext`,
 * so a Tutorials tab reads the same in a window with no project open as in one
 * with a checkout — which is the state a person reading "your first project" is
 * most likely to be in.
 */
import { useCallback, useEffect, useState } from "react";
import { on, reportPainted, OPENED_EVENT } from "@veistra/bridge";
import { BODIES } from "./content";
import Reader from "./Reader";
import Contents from "./Contents";
import Index from "./Index";
import { useCatalog, type Tutorial } from "./useCatalog";
import "./tutorial.css";

export default function App() {
  const session = useCatalog();
  const [openId, setOpenId] = useState<string | null>(null);

  /**
   * Home opens a particular tutorial by asking the shell for this app and
   * naming one — the same `veistra/open` path the Explorer uses to put a file in
   * the Viewer. An unknown id is ignored rather than shown as an error: it can
   * only come from a build mismatch, and dropping the reader on the index is a
   * better answer than a page saying the link was wrong.
   */
  useEffect(
    () =>
      on(OPENED_EVENT, (payload) => {
        const id = (payload as { tutorialId?: unknown } | null)?.tutorialId;
        if (typeof id === "string" && id in BODIES) setOpenId(id);
      }),
    [],
  );

  /**
   * The splash window waits on this — see `apps/README.md`. The condition is
   * "the first answer landed", either way it went: a Tutorials pane that could
   * not read its catalog has still finished drawing, and holding the window
   * back for a screen that is not going to improve only makes the bad news
   * slower to arrive.
   */
  useEffect(() => {
    if (session.settled) reportPainted();
  }, [session.settled]);

  const open = useCallback((id: string | null) => {
    setOpenId(id);
    // Back to the top, because the reader and the index share one scroll
    // container and arriving halfway down a tutorial you just opened reads as
    // a rendering bug.
    document.querySelector(".tut__main")?.scrollTo({ top: 0 });
  }, []);

  const { catalog, error, settled } = session;
  const tutorials = catalog?.tutorials ?? [];
  const current: Tutorial | undefined = tutorials.find((t) => t.id === openId);

  return (
    <div className="app tut">
      {catalog && (
        <Contents
          catalog={catalog}
          openId={openId}
          isDone={session.isDone}
          onOpen={open}
          onReset={session.resetAll}
        />
      )}

      <main className="tut__main">
        {error !== null && <p className="tut__error">{error}</p>}

        {!settled && <p className="tut__waiting">Reading…</p>}

        {catalog && current && (
          <Reader
            tutorial={current}
            body={BODIES[current.id]}
            next={nextAfter(tutorials, current)}
            done={session.isDone(current.id)}
            onDone={(done) => session.setDone(current.id, done)}
            onOpen={open}
          />
        )}

        {catalog && !current && <Index catalog={catalog} isDone={session.isDone} onOpen={open} />}
      </main>
    </div>
  );
}

/**
 * What to read next: the first tutorial declaring itself as coming *after* this
 * one, and failing that the next one in the list.
 *
 * Derived rather than stored as a `next` field, because `after` is the direction
 * a writer can get right — you know what a tutorial assumes, not what will one
 * day be written to follow it. The list order is the fallback so a tutorial
 * nothing points at still leads somewhere.
 */
function nextAfter(tutorials: Tutorial[], current: Tutorial): Tutorial | null {
  const declared = tutorials.find((t) => t.after === current.id);
  if (declared) return declared;

  const at = tutorials.findIndex((t) => t.id === current.id);
  return tutorials[at + 1] ?? null;
}
