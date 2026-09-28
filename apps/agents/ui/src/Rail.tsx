import { useState } from "react";
import {
  type MachineGroup,
  type RunGroup,
  type State,
  ago,
  keyOf,
  machineLabel,
  machineTone,
  stateOf,
  stateTone,
  titleOf,
} from "./model";
import type { Session } from "./rpc";

/** Recent sessions shown per machine before "Show more". */
const RECENT_SHOWN = 8;

export interface RowContext {
  now: number;
  selected: string | null;
  onSelect: (key: string) => void;
  /** First requests learned from transcripts already opened, by session key. */
  requests: Record<string, string>;
}

const STATE_WORD: Record<State, string> = {
  running: "running",
  idle: "waiting for input",
  ended: "ended",
  stale: "no word for 30 min",
  unknown: "status unreadable",
};

export function stateWord(state: State): string {
  return STATE_WORD[state];
}

function SessionRow({
  session,
  ctx,
  detail,
}: {
  session: Session;
  ctx: RowContext;
  /** The second line's lead: the workflow step, or the agent in the run view. */
  detail?: string;
}) {
  const key = keyOf(session);
  const state = stateOf(session, ctx.now);
  const updated = session.status?.updated ?? session.written;
  return (
    <li>
      <button
        type="button"
        className="app__row agents__session"
        aria-current={ctx.selected === key}
        onClick={() => ctx.onSelect(key)}
      >
        <span className={`app__dot agents__dot--${stateTone[state]}`} aria-hidden />
        <span className="agents__session-text">
          <span className="app__name">{titleOf(session, ctx.requests[key])}</span>
          <span className="agents__session-sub">
            {detail ? `${detail} · ` : ""}
            {stateWord(state)} · {ago(updated, ctx.now)}
          </span>
        </span>
      </button>
    </li>
  );
}

function StartControl({
  group,
  onStart,
}: {
  group: MachineGroup;
  onStart: (name: string) => Promise<void>;
}) {
  const [phase, setPhase] = useState<"idle" | "confirm" | "starting">("idle");
  const machine = group.machine;
  if (!machine || machine.status !== "TERMINATED") return null;
  if (phase === "idle") {
    return (
      <button type="button" className="app__up" onClick={() => setPhase("confirm")}>
        Start
      </button>
    );
  }
  return (
    <span className="agents__confirm">
      <span className="app__note">Bills {machine.machineType} until it stops itself.</span>
      <button
        type="button"
        className="app__up agents__confirm-yes"
        disabled={phase === "starting"}
        onClick={() => {
          setPhase("starting");
          void onStart(machine.name).finally(() => setPhase("idle"));
        }}
      >
        {phase === "starting" ? "Starting…" : "Start"}
      </button>
      <button
        type="button"
        className="app__up"
        disabled={phase === "starting"}
        onClick={() => setPhase("idle")}
      >
        Cancel
      </button>
    </span>
  );
}

function stepOf(session: Session): string | undefined {
  const wf = session.status?.workflow;
  return wf ? `${wf.name} · ${wf.step}` : undefined;
}

export function MachineRail({
  groups,
  ctx,
  onStart,
}: {
  groups: MachineGroup[];
  ctx: RowContext;
  onStart: (name: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (groups.length === 0) {
    return <p className="app__note">No agent machines and no sessions yet.</p>;
  }
  return (
    <>
      {groups.map((group) => {
        const all = expanded[group.name] === true;
        const recent = all ? group.recent : group.recent.slice(0, RECENT_SHOWN);
        const machine = group.machine;
        return (
          <section key={group.name} className="app__section">
            <div className="agents__machine">
              <span
                className={`app__dot agents__dot--${machine ? machineTone(machine.status) : "off"}`}
                aria-hidden
              />
              <span className="agents__machine-name">{group.name}</span>
              <span className="app__meta">
                {machine
                  ? `${machine.machineType} · ${machineLabel(machine.status)}`
                  : "not in Compute"}
              </span>
              <StartControl group={group} onStart={onStart} />
            </div>
            {group.live.length > 0 && (
              <>
                <h3 className="app__label agents__sublabel">Live</h3>
                <ul className="app__rows">
                  {group.live.map((s) => (
                    <SessionRow key={keyOf(s)} session={s} ctx={ctx} detail={stepOf(s)} />
                  ))}
                </ul>
              </>
            )}
            {group.recent.length > 0 && (
              <>
                <h3 className="app__label agents__sublabel">Recent</h3>
                <ul className="app__rows">
                  {recent.map((s) => (
                    <SessionRow key={keyOf(s)} session={s} ctx={ctx} detail={stepOf(s)} />
                  ))}
                </ul>
                {group.recent.length > RECENT_SHOWN && (
                  <button
                    type="button"
                    className="agents__more"
                    onClick={() => setExpanded({ ...expanded, [group.name]: !all })}
                  >
                    {all ? "Show fewer" : `Show ${group.recent.length - RECENT_SHOWN} more`}
                  </button>
                )}
              </>
            )}
            {group.live.length === 0 && group.recent.length === 0 && (
              <p className="app__note agents__empty">No sessions recorded.</p>
            )}
          </section>
        );
      })}
    </>
  );
}

export function WorkflowRail({ runs, ctx }: { runs: RunGroup[]; ctx: RowContext }) {
  if (runs.length === 0) return <p className="app__note">No sessions yet.</p>;
  return (
    <>
      {runs.map((run) => (
        <section key={`${run.workflow ?? ""}/${run.run ?? ""}`} className="app__section">
          <div className="agents__machine">
            <span className="agents__machine-name">
              {run.workflow ? `${run.workflow} · ${run.run}` : "Started by hand"}
            </span>
            <span className="app__meta">{ago(run.latest, ctx.now)}</span>
          </div>
          <ul className="app__rows">
            {run.sessions.map((s) => (
              <SessionRow
                key={keyOf(s)}
                session={s}
                ctx={ctx}
                detail={run.workflow ? `${s.status?.workflow?.step} on ${s.agent}` : s.agent}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
