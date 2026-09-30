import { Search } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { type HindsightStatus, hindsightStatus } from "../../bindings";
import "./hindsightpage.css";

/** Longer than the backend's own 20 s request limit plus a `gcloud` token run. */
const CHECK_TIMEOUT_MS = 30_000;

type Phase =
  | { kind: "checking" }
  | { kind: "done"; status: HindsightStatus }
  | { kind: "failed"; message: string; timedOut: boolean };

/** Why a check ended in `failed`: nothing answered at all, or too slowly. */
class CheckTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new CheckTimeout("timed out")), ms);
    work.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * What to tell someone whose check ended in a trouble, in the words of the
 * backend's `cloud::Trouble` tag. Every branch names the missing piece and
 * the command that fixes it. There is no Settings section for Google Cloud:
 * OpenKaava holds no keys and uses this machine's `gcloud` login, and the
 * copy says so instead of linking nowhere.
 */
function troubleNote(trouble: { kind: string }): { heading: string; steps: ReactNode } {
  switch (trouble.kind) {
    case "gcloudMissing":
      return {
        heading: "The Google Cloud CLI is not installed",
        steps: (
          <>
            Hindsight is reached with your own <code>gcloud</code> login. Install the CLI from
            cloud.google.com/sdk, run <code>gcloud auth login</code>, then check again.
          </>
        ),
      };
    case "signedOut":
      return {
        heading: "Signed out of Google Cloud",
        steps: (
          <>
            Run <code>gcloud auth login</code> in a terminal, then check again.
          </>
        ),
      };
    case "denied":
      return {
        heading: "This Google account may not call Hindsight",
        steps: (
          <>
            Hindsight sits behind Google IAM. Ask a project owner for the Cloud Run Invoker role on
            the Hindsight service, or switch account with <code>gcloud config set account</code>.
          </>
        ),
      };
    case "missing":
      return {
        heading: "Hindsight is not deployed at that address",
        steps: (
          <>
            Deploy it from <code>infra/terraform/hindsight</code>, or point OpenKaava at the right
            service by setting <code>KAAVA_HINDSIGHT_URL</code> before it starts.
          </>
        ),
      };
    case "unreachable":
      return {
        heading: "Hindsight did not answer",
        steps: <>Check the network connection or proxy, then check again.</>,
      };
    default:
      return {
        heading: "Hindsight answered with an error",
        steps: <>The service is reachable but unhealthy. Check its Cloud Run logs.</>,
      };
  }
}

/**
 * Hindsight's docked body: whether the shared agent memory service is up.
 *
 * It asks once when the page opens and again only when "Check again" is
 * pressed. `docs/cloud-services.md` §8: every request keeps a billed Cloud Run
 * instance alive, so this never polls and never runs at startup.
 *
 * What it does not do is read memories. The recall API is looked up from the
 * service's own `openapi.json` after deploy, and no banks are listed here that
 * the service has not reported, so the search field stays disabled rather than
 * pretend. Agents recall through the MCP connection named below.
 */
export default function HindsightPage({
  check = hindsightStatus,
  timeoutMs = CHECK_TIMEOUT_MS,
}: {
  check?: () => Promise<HindsightStatus>;
  timeoutMs?: number;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  // A stale answer must not overwrite a newer press of "Check again".
  const latest = useRef(0);

  const run = useCallback(() => {
    const id = ++latest.current;
    setPhase({ kind: "checking" });
    withTimeout(check(), timeoutMs).then(
      (status) => {
        if (id === latest.current) setPhase({ kind: "done", status });
      },
      (error: unknown) => {
        if (id !== latest.current) return;
        setPhase({
          kind: "failed",
          timedOut: error instanceof CheckTimeout,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, [check, timeoutMs]);

  useEffect(() => {
    run();
    return () => {
      latest.current += 1;
    };
  }, [run]);

  const connected = phase.kind === "done" && phase.status.state === "connected";
  const busy = phase.kind === "checking";

  return (
    <div className="k-hindsight">
      <div className="k-hindsight__status">
        <span
          className={`k-hindsight__pill k-hindsight__pill--${
            connected ? "ok" : busy ? "busy" : "down"
          }`}
          role="status"
        >
          {connected ? "Connected" : busy ? "Checking…" : "Not connected"}
        </span>
        {phase.kind === "done" && (
          <span className="k-hindsight__url" title={phase.status.url}>
            {phase.status.url.replace(/^https?:\/\//, "")}
            {phase.status.state === "connected" && ` · ${phase.status.latencyMs} ms`}
          </span>
        )}
        <button type="button" className="k-hindsight__again" disabled={busy} onClick={run}>
          Check again
        </button>
      </div>

      {phase.kind === "checking" && (
        <p className="k-hindsight__note">
          Asking the service. A cold Cloud Run instance can take a few seconds.
        </p>
      )}

      {phase.kind === "failed" && (
        <section className="k-hindsight__section" data-state="failed">
          <h3 className="k-hindsight__heading">
            {phase.timedOut ? "Hindsight did not answer in time" : "Could not check Hindsight"}
          </h3>
          <p className="k-hindsight__empty">
            {phase.timedOut
              ? "No answer within the time limit. Check the network connection, then check again."
              : `${phase.message}. The check runs inside the OpenKaava desktop app; a browser-only build has no backend to ask.`}
          </p>
        </section>
      )}

      {phase.kind === "done" && phase.status.state === "trouble" && (
        <section className="k-hindsight__section" data-state="trouble">
          <h3 className="k-hindsight__heading">{troubleNote(phase.status.trouble).heading}</h3>
          <p className="k-hindsight__empty">{troubleNote(phase.status.trouble).steps}</p>
        </section>
      )}

      <div className="k-hindsight__search" aria-disabled="true">
        <Search size={13} strokeWidth={1.5} aria-hidden />
        <span>Recall from memory…</span>
      </div>

      <section className="k-hindsight__section">
        <h3 className="k-hindsight__heading">Memory banks</h3>
        <p className="k-hindsight__empty">
          Agents read banks over MCP at <code>&lt;url&gt;/mcp/&lt;bank&gt;/</code>. This page does
          not list or search them yet; it shows only whether the service is up.
        </p>
      </section>
    </div>
  );
}
