import { useEffect, useState } from "react";
import { VeistraRpcError, host, invoke, on, session, type Session } from "@veistra/bridge";

interface CallLogEntry {
  method: string;
  ok: boolean;
  detail: string;
}

/**
 * Reference frontend for the tool protocol. Deliberately plain — this is a
 * demo of the wire contract, not a design exercise. Each button below walks
 * a distinct path through docs/tool-protocol.md §3/§4: a plain request, a
 * namespaced method, a pushed notification, and an unknown method surfacing
 * its JSON-RPC error code. Every one of those is worth seeing separately,
 * which is why there isn't just a single "call echo" button.
 */
export default function App() {
  const [text, setText] = useState("hello");
  const [log, setLog] = useState<CallLogEntry[]>([]);
  const [notifications, setNotifications] = useState<unknown[]>([]);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);

  useEffect(() => {
    void session().then(setCurrentSession);
  }, []);

  useEffect(() => {
    // `echo/notify` (below) asks the tool core to push this back asynchronously
    // rather than returning it — `on` is how either host's transport surfaces
    // that as a callback instead of a response.
    return on("echo/notified", (payload) => {
      setNotifications((prev) => [...prev, payload]);
    });
  }, []);

  async function call(method: string, params?: unknown) {
    try {
      const result = await invoke(method, params);
      setLog((prev) => [{ method, ok: true, detail: JSON.stringify(result) }, ...prev]);
    } catch (err) {
      // A VeistraRpcError carries the JSON-RPC code either host produced it
      // from (shell error envelope, Tauri rejection, or a local timeout) —
      // that's what makes this branch worth showing on its own.
      const detail = err instanceof VeistraRpcError ? `[${err.code}] ${err.message}` : String(err);
      setLog((prev) => [{ method, ok: false, detail }, ...prev]);
    }
  }

  return (
    <main className="echo">
      <h1>Echo tool</h1>

      <dl className="echo__meta">
        <dt>Host</dt>
        <dd>
          <code>{host()}</code>
        </dd>
        <dt>Session</dt>
        <dd>
          <code>{currentSession ? JSON.stringify(currentSession) : "resolving…"}</code>
        </dd>
      </dl>

      <label className="echo__field">
        Text
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>

      <div className="echo__buttons">
        <button type="button" onClick={() => void call("echo", { text })}>
          echo
        </button>
        <button type="button" onClick={() => void call("echo/upper", { text })}>
          echo/upper
        </button>
        <button type="button" onClick={() => void call("echo/notify", { text })}>
          echo/notify
        </button>
        <button type="button" onClick={() => void call("does/not-exist")}>
          unknown method
        </button>
      </div>

      <section>
        <h2>Calls</h2>
        <ul className="echo__log">
          {log.length === 0 && <li className="echo__empty">No calls yet.</li>}
          {log.map((entry, i) => (
            <li key={i} className={entry.ok ? "echo__ok" : "echo__err"}>
              <code>{entry.method}</code> → {entry.detail}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Notifications</h2>
        <ul className="echo__log">
          {notifications.length === 0 && <li className="echo__empty">None received.</li>}
          {notifications.map((payload, i) => (
            <li key={i}>
              <code>echo/notified</code> → {JSON.stringify(payload)}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
