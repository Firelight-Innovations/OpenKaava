import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { stateWord } from "./Rail";
import { ago, keyOf, stateOf, stateTone, titleOf } from "./model";
import * as rpc from "./rpc";
import type { Session } from "./rpc";
import { type Entry, type Parsed, firstRequest, parseTranscript } from "./transcript";

/** A tool result longer than this shows its head and a count of the rest. */
const RESULT_SHOWN = 4000;

interface Loaded {
  key: string;
  generation: number | null;
  parsed: Parsed;
  truncated: boolean;
  size: number;
}

export function SessionView({
  session,
  now,
  request,
  onRequest,
  machineStatus,
}: {
  session: Session;
  now: number;
  machineStatus: string | null;
  request: string | undefined;
  onRequest: (key: string, text: string) => void;
}) {
  const key = keyOf(session);
  const state = stateOf(session, now, machineStatus);
  const status = session.status;
  const wf = status?.workflow;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const held = useRef<{ key: string; generation: number | null } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const wanted = session.transcript?.generation ?? null;

  // Refetch when the overview reports a new transcript generation; the
  // backend answers `unchanged` without a download when it is the same.
  useEffect(() => {
    let cancelled = false;
    const known = held.current?.key === key ? held.current.generation : null;
    rpc
      .transcript(session.agent, session.sessionId, known)
      .then((t) => {
        if (cancelled || (t.unchanged && known !== null)) return;
        const parsed = parseTranscript(t.text);
        held.current = { key, generation: t.generation };
        setLoaded({ key, generation: t.generation, parsed, truncated: t.truncated, size: t.size });
        setFailure(null);
        const first = firstRequest(parsed);
        if (first) onRequest(key, first);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailure(rpc.messageOf(e));
      });
    return () => {
      cancelled = true;
    };
  }, [key, wanted, session.agent, session.sessionId, onRequest]);

  const shown = loaded?.key === key ? loaded : null;

  // Open at the newest turn, which is what a person checking in wants.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && shown) el.scrollTop = el.scrollHeight;
  }, [shown]);

  return (
    <div className="app__pane agents__detail">
      <header className="agents__detail-head">
        <h2 className="agents__title">{titleOf(session, request ?? shown?.parsed.summary)}</h2>
        <span className={`agents__state agents__state--${stateTone[state]}`}>
          {stateWord(state)}
        </span>
      </header>
      {state === "stale" && (
        <p className="app__note agents__warn">
          The last event said running, {ago(status?.updated, now)}. The machine may have stopped
          mid-turn; a stopped machine never reports that its session ended.
        </p>
      )}
      <dl className="agents__facts">
        <dt>Agent</dt>
        <dd>{session.agent}</dd>
        {wf && (
          <>
            <dt>Workflow</dt>
            <dd>
              {wf.name} · run {wf.run} · step {wf.step}
            </dd>
          </>
        )}
        <dt>Last event</dt>
        <dd>
          {status?.last_event ?? "none"} · {ago(status?.updated ?? session.written, now)}
          {status?.end_reason ? ` · ${status.end_reason}` : ""}
        </dd>
        {status?.cwd && (
          <>
            <dt>Directory</dt>
            <dd className="app__path">{status.cwd}</dd>
          </>
        )}
        <dt>Session</dt>
        <dd className="app__path">{session.sessionId}</dd>
      </dl>

      <h3 className="app__label">Transcript</h3>
      {state === "running" && (
        <p className="app__note agents__lag">
          The transcript uploads each time the agent stops for input, so the turn in progress is not
          here yet.
        </p>
      )}
      <div className="app__scroll agents__transcript" ref={scroller}>
        {failure && <p className="app__error">{failure}</p>}
        {!failure && !shown && <p className="app__note">Loading…</p>}
        {shown && shown.generation === null && (
          <p className="app__note">No transcript yet. It first uploads when the agent stops.</p>
        )}
        {shown?.truncated && (
          <p className="app__note">
            Showing the last 4 MiB of {(shown.size / (1 << 20)).toFixed(1)} MiB.
          </p>
        )}
        {shown?.parsed.entries.map((entry, i) => (
          <EntryView key={i} entry={entry} />
        ))}
        {shown && shown.parsed.unreadable > 0 && (
          <p className="app__note">
            {shown.parsed.unreadable} lines were not JSON and are left out.
          </p>
        )}
      </div>
    </div>
  );
}

function clip(text: string): string {
  if (text.length <= RESULT_SHOWN) return text;
  return `${text.slice(0, RESULT_SHOWN)}\n… ${text.length - RESULT_SHOWN} more characters`;
}

function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case "user":
      return (
        <div className="agents__turn agents__turn--user">
          <span className="agents__who">Request</span>
          <p className="agents__text">{entry.text}</p>
        </div>
      );
    case "assistant":
      return (
        <div className="agents__turn">
          <p className="agents__text">{entry.text}</p>
        </div>
      );
    case "tool":
      return (
        <details className={`agents__tool${entry.isError ? " agents__tool--err" : ""}`}>
          <summary>
            <span className="agents__tool-name">{entry.name}</span>
            <span className="agents__tool-sum">{entry.summary}</span>
            {entry.isError && <span className="agents__tool-flag">error</span>}
            {entry.result === null && <span className="agents__tool-flag">no result</span>}
          </summary>
          <pre className="app__code">{JSON.stringify(entry.input, null, 2)}</pre>
          {entry.result !== null && <pre className="app__code">{clip(entry.result)}</pre>}
        </details>
      );
    case "system":
      return <p className="app__note agents__system">{entry.text}</p>;
    case "other":
      return (
        <details className="agents__tool">
          <summary>
            <span className="agents__tool-name">{entry.type}</span>
          </summary>
          <pre className="app__code">{clip(entry.raw)}</pre>
        </details>
      );
  }
}
