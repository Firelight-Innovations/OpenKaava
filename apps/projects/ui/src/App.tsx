import { reportPainted } from "@openkaava/bridge";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectUrl } from "./planeRoutes";
import * as rpc from "./rpc";
import type { HostsCheck, ProjectRecord, ProjectsList, WakeSnapshot } from "./rpc";

/** How often `projects/wake-status` is polled while a wake is in flight —
 * fast enough that "Starting Plane… Ns" reads as live, cheap enough that it
 * never competes with the 3 s the backend itself polls at. */
const WAKE_POLL_MS = 1000;

export default function App() {
  const [list, setList] = useState<ProjectsList | null>(null);
  const [listError, setListError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [wake, setWake] = useState<WakeSnapshot>({ phase: "idle" });
  const [hosts, setHosts] = useState<HostsCheck | null>(null);
  const [webviewError, setWebviewError] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const openedFor = useRef<string | null>(null);

  useEffect(() => {
    rpc.list().then(setList).catch(setListError);
  }, []);

  useEffect(() => {
    if (list || listError) reportPainted();
  }, [list, listError]);

  // Close the webview behind us rather than leave it pointed at a dead pane —
  // `plane_webview::close` is a no-op if one was never opened.
  useEffect(() => () => void rpc.webviewClose().catch(() => {}), []);

  const project: ProjectRecord | null = useMemo(
    () => list?.projects.find((p) => p.slug === selected) ?? null,
    [list, selected],
  );

  // Poll `projects/wake-status` while a wake is running. `useVisiblePoll`
  // (see `apps/agents/ui`) is the wrong shape here: this is a one-shot flow
  // with its own start/stop, not a continuous refresh the tab should keep
  // alive in the background.
  useEffect(() => {
    if (wake.phase !== "waking") return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = await rpc.wakeStatus();
        if (!cancelled) setWake(next);
      } catch {
        // A poll that fails to even reach the backend is not itself a wake
        // failure — leave the last known snapshot in place and try again.
      }
    }, WAKE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [wake]);

  // Once healthy, open (or navigate) the webview at this project's issue
  // board. Guarded by `openedFor` so a re-render mid-wake does not re-issue
  // the same open call every poll tick.
  useEffect(() => {
    if (wake.phase !== "healthy" || !project) return;
    if (openedFor.current === project.slug) return;
    const rect = paneRef.current?.getBoundingClientRect();
    if (!rect) return;
    openedFor.current = project.slug;
    const url = projectUrl(project.plane.project_id);
    const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    rpc.webviewOpen(bounds, url).catch((e) => setWebviewError(rpc.messageOf(e)));
  }, [wake, project]);

  // Track the pane's own rect so a resize (a split changing, the window
  // itself resizing) keeps the webview lined up. Rust places the webview
  // because its position is a platform property an iframe cannot reach
  // across the process boundary — see `plane_webview`'s module doc.
  useEffect(() => {
    const el = paneRef.current;
    if (!el || wake.phase !== "healthy") return;
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      void rpc
        .webviewBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
        .catch(() => {});
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [wake.phase]);

  const select = useCallback(async (record: ProjectRecord) => {
    setSelected(record.slug);
    setWebviewError(null);
    openedFor.current = null;
    setWake({ phase: "idle" });
    try {
      setHosts(await rpc.hostsCheck());
    } catch {
      setHosts(null);
    }
    try {
      await rpc.wakeStart();
      setWake(await rpc.wakeStatus());
    } catch (e) {
      setWake({ phase: "failed", detail: rpc.messageOf(e) });
    }
  }, []);

  const cancel = useCallback(() => {
    void rpc.wakeCancel();
  }, []);

  const blocking = !list && listError !== null;

  return (
    <div className="app">
      <header className="app__head">
        <h1 className="app__title">Projects</h1>
        {list && (
          <span className="app__sub">
            {list.profile}
            {list.source === "fixture" && <span className="projects__badge">fixture</span>}
          </span>
        )}
      </header>
      <div className="app__body projects__body">
        {blocking ? (
          <section className="app__section">
            <p className="app__error">Could not list projects: {rpc.messageOf(listError)}</p>
          </section>
        ) : !list ? (
          <p className="app__note">Reading the project list…</p>
        ) : (
          <div className="app__split projects__split">
            <nav className="app__pane" aria-label="Projects">
              <div className="app__scroll">
                {list.problems.map((message) => (
                  <p key={message} className="app__error projects__problem">
                    {message}
                  </p>
                ))}
                {list.projects.length === 0 ? (
                  <p className="app__note">
                    No projects yet. `kaava-project` writes one to{" "}
                    <code>gs://veistra-projects/{list.profile}/projects/</code> per project.
                  </p>
                ) : (
                  <ul className="app__rows">
                    {list.projects.map((p) => (
                      <li key={p.slug}>
                        <button
                          type="button"
                          className="app__row"
                          aria-current={p.slug === selected}
                          onClick={() => void select(p)}
                        >
                          <span className="app__dot" />
                          <span className="app__name">
                            {p.name}
                            {p.archived && <span className="projects__archived">archived</span>}
                          </span>
                          <span className="app__meta">{p.plane.identifier}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </nav>
            <section className="app__pane projects__plane" aria-label="Plane">
              {!project ? (
                <p className="app__note">Pick a project to open its Plane workspace.</p>
              ) : (
                <>
                  {hosts && !hosts.ok && <p className="app__error projects__fix">{hosts.fix}</p>}
                  {webviewError && <p className="app__error">{webviewError}</p>}
                  <WakeStatus wake={wake} onCancel={cancel} />
                  {/* The child webview draws over this element — see
                      `plane_webview`'s module doc for why Rust, not this
                      div's own content, is what makes Plane visible here. */}
                  <div ref={paneRef} className="projects__pane-target" />
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function WakeStatus({ wake, onCancel }: { wake: WakeSnapshot; onCancel: () => void }) {
  switch (wake.phase) {
    case "idle":
      return null;
    case "waking":
      return (
        <div className="projects__waking">
          <p className="app__note">
            Starting Plane… {Math.round(wake.elapsedSeconds)}s — {wake.detail}
          </p>
          <button type="button" className="app__up" onClick={onCancel}>
            Cancel
          </button>
        </div>
      );
    case "healthy":
      return null;
    case "cancelled":
      return <p className="app__note">Cancelled.</p>;
    case "timedOut":
      return <p className="app__error">Plane did not come up in time: {wake.detail}</p>;
    case "failed":
      return <p className="app__error">Could not start Plane: {wake.detail}</p>;
  }
}
