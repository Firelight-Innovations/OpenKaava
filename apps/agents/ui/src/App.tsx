import { reportPainted } from "@openkaava/bridge";
import { useCallback, useEffect, useMemo, useState } from "react";
import { TroubleNote } from "../../../shared/trouble";
import { MachineRail, type RowContext, WorkflowRail } from "./Rail";
import { SessionView } from "./SessionView";
import { byMachine, byWorkflow, keyOf, machineStatusOf } from "./model";
import * as rpc from "./rpc";
import type { Overview } from "./rpc";
import { useVisiblePoll } from "./useVisiblePoll";

/** `docs/cloud-services.md` §8: poll the bucket every few seconds while shown. */
const POLL_MS = 5000;

type View = "machines" | "workflows";

export default function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [now, setNow] = useState(() => Date.now());
  const [view, setView] = useState<View>("machines");
  const [selected, setSelected] = useState<string | null>(null);
  const [requests, setRequests] = useState<Record<string, string>>({});
  const [startError, setStartError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setOverview(await rpc.overview());
      setFailure(null);
    } catch (e) {
      setFailure(e);
    } finally {
      setNow(Date.now());
    }
  }, []);
  useVisiblePoll(refresh, POLL_MS);

  useEffect(() => {
    if (overview || failure) reportPainted();
  }, [overview, failure]);

  const onRequest = useCallback((key: string, text: string) => {
    setRequests((r) => (r[key] === text ? r : { ...r, [key]: text }));
  }, []);

  const onStart = useCallback(
    async (name: string) => {
      setStartError(null);
      try {
        await rpc.startMachine(name);
        await refresh();
      } catch (e) {
        setStartError(`Could not start ${name}: ${rpc.messageOf(e)}`);
      }
    },
    [refresh],
  );

  const machines = useMemo(() => (overview ? byMachine(overview, now) : []), [overview, now]);
  const runs = useMemo(() => (overview ? byWorkflow(overview.sessions) : []), [overview]);

  // Until a person picks one, show the newest live session, else the newest.
  const current = useMemo(() => {
    const sessions = overview?.sessions ?? [];
    const picked = sessions.find((s) => keyOf(s) === selected);
    if (picked) return picked;
    const live = machines.flatMap((g) => g.live);
    return live[0] ?? machines.flatMap((g) => g.recent)[0] ?? null;
  }, [overview, selected, machines]);

  const ctx: RowContext = {
    now,
    selected: current ? keyOf(current) : null,
    onSelect: setSelected,
    requests,
    machineStatus: (agent) => (overview ? machineStatusOf(overview, agent) : null),
  };

  const blocking = !overview && failure !== null;

  return (
    <div className="app">
      <header className="app__head">
        <h1 className="app__title">Agents</h1>
        {overview && (
          <span className="app__sub">
            {overview.project}
            {overview.source === "fixture" && <span className="agents__badge">fixture</span>}
          </span>
        )}
        <div className="agents__views" role="tablist" aria-label="Group sessions by">
          {(["machines", "workflows"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className="agents__view"
              onClick={() => setView(v)}
            >
              {v === "machines" ? "Machines" : "Workflows"}
            </button>
          ))}
        </div>
        <span className="app__host">
          {overview ? "every 5 s while shown" : blocking ? "not connected" : "connecting…"}
        </span>
      </header>
      <div className="app__body">
        {blocking ? (
          <Blocked failure={failure} onRetry={() => void refresh()} />
        ) : !overview ? (
          <p className="app__note">Reading the project…</p>
        ) : (
          <div className="app__split app__split--stack agents__split">
            <nav className="app__pane" aria-label="Sessions">
              <div className="app__scroll agents__rail">
                {failure !== null && (
                  <p className="app__error">
                    Last refresh failed: {rpc.messageOf(failure)}. Showing the previous result.
                  </p>
                )}
                {overview.problems.map((p) => (
                  <p key={p.area} className="app__error">
                    {p.area === "machines" ? "Machines" : "Sessions"}: {p.message}
                  </p>
                ))}
                {startError && <p className="app__error">{startError}</p>}
                {view === "machines" ? (
                  <MachineRail groups={machines} ctx={ctx} onStart={onStart} />
                ) : (
                  <WorkflowRail runs={runs} ctx={ctx} />
                )}
              </div>
            </nav>
            {current ? (
              <SessionView
                key={keyOf(current)}
                session={current}
                now={now}
                request={requests[keyOf(current)]}
                onRequest={onRequest}
                machineStatus={overview ? machineStatusOf(overview, current.agent) : null}
              />
            ) : (
              <p className="app__note">Pick a session to read what the agent did.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The whole-pane state for a failure nothing else can get past. */
function Blocked({ failure, onRetry }: { failure: unknown; onRetry: () => void }) {
  return <TroubleNote failure={failure} subject="Agents" onRetry={onRetry} />;
}
