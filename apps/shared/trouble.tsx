import type { ReactNode } from "react";

/**
 * The whole-pane state for a failed cloud call, shared by the Plane, Cloud
 * agents and Cost pages so each says the same true thing about the same cause:
 * what is missing, and how to set it up.
 *
 * Duck-typed on `code` and `data.kind` rather than importing the bridge, so it
 * works under each app's stubbed bridge in tests. `data.kind` is the backend's
 * `cloud::Trouble` tag; `-32001` is the bridge's own timeout code.
 *
 * Most reads use the `gcloud` login on the machine (`docs/cloud-services.md`
 * §2), so their setup is a terminal command, and the note says so. The one
 * exception is `signInNeeded`: OpenKaava's own Google sign-in, which lives in
 * Settings, Cloud.
 */

const TIMEOUT_CODE = -32001;

export interface FailureNote {
  kind: string;
  heading: string;
  steps: ReactNode;
  detail: string;
}

function kindOf(error: unknown): string | null {
  const data = (error as { data?: { kind?: unknown } } | null)?.data;
  return data && typeof data.kind === "string" ? data.kind : null;
}

export function messageOfFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What went wrong and what to do about it, for a failure of a cloud read. */
export function describeFailure(error: unknown, subject: string): FailureNote {
  const detail = messageOfFailure(error);
  if ((error as { code?: unknown } | null)?.code === TIMEOUT_CODE) {
    return {
      kind: "timeout",
      heading: `Reading ${subject} timed out`,
      steps: (
        <p className="app__note">
          Google Cloud did not answer in time. Check the network connection, then retry. A first
          read can be slow; it is not stuck.
        </p>
      ),
      detail,
    };
  }
  const kind = kindOf(error) ?? "other";
  switch (kind) {
    case "gcloudMissing":
      return {
        kind,
        heading: "The Google Cloud CLI is not installed",
        steps: (
          <p className="app__note">
            {subject} reads Google Cloud through your own <code>gcloud</code> login. Install the CLI
            from cloud.google.com/sdk, run <code>gcloud auth login</code>, then retry. There is no
            Settings section for this; nothing is stored in OpenKaava.
          </p>
        ),
        detail,
      };
    case "signedOut":
      return {
        kind,
        heading: "Signed out of Google Cloud",
        steps: (
          <p className="app__note">
            Run <code>gcloud auth login</code> in a terminal, then retry. There is no Settings
            section for this; OpenKaava uses the <code>gcloud</code> login on this machine.
          </p>
        ),
        detail,
      };
    case "denied":
      return {
        kind,
        heading: "This Google account may not read that",
        steps: (
          <p className="app__note">
            Check which account is active with <code>gcloud auth list</code>, and switch with{" "}
            <code>gcloud config set account</code>. Otherwise ask a project owner for read access.
          </p>
        ),
        detail,
      };
    case "missing":
      return {
        kind,
        heading: "Not deployed yet",
        steps: (
          <p className="app__note">
            What {subject} reads does not exist in this Google Cloud project. If the project is
            wrong, set <code>KAAVA_GCP_PROJECT</code> before starting OpenKaava.
          </p>
        ),
        detail,
      };
    case "unreachable":
      return {
        kind,
        heading: "Google Cloud did not answer",
        steps: (
          <p className="app__note">
            Check the network connection or proxy, then retry. Nothing is wrong with your login as
            far as OpenKaava can tell.
          </p>
        ),
        detail,
      };
    case "signInNeeded":
      return {
        kind,
        heading: "Sign in to Google again",
        steps: (
          <p className="app__note">
            OpenKaava&apos;s Google sign-in has lapsed. Open Settings, Cloud, and press Sign in with
            Google, then retry.
          </p>
        ),
        detail,
      };
    case "gatewayUnconfigured":
      return {
        kind,
        heading: "The Plane gateway is not set up",
        steps: (
          <p className="app__note">
            {subject} reaches Plane through the kaava-api gateway. Paste its URL into Settings,
            Cloud, Gateway URL. Until it is deployed, see <code>services/kaava-api/README.md</code>.
          </p>
        ),
        detail,
      };
    case "gatewayUnreachable":
      return {
        kind,
        heading: "The Plane gateway did not answer",
        steps: (
          <p className="app__note">
            Check the network connection and the Gateway URL in Settings, Cloud, then retry. The
            gateway may take a few seconds to start after a quiet spell.
          </p>
        ),
        detail,
      };
    case "planeAsleep":
      return {
        kind,
        heading: "Plane is not running",
        steps: (
          <p className="app__note">
            plane-vm is stopped or still starting. Pick the project again to start Plane, then
            retry.
          </p>
        ),
        detail,
      };
    default:
      return { kind, heading: `Could not read ${subject}`, steps: null, detail };
  }
}

/** The failure, the fix, and a Retry. `subject` is the page's noun: "Cost", "Agents". */
export function TroubleNote({
  failure,
  subject,
  onRetry,
}: {
  failure: unknown;
  subject: string;
  onRetry: () => void;
}) {
  const note = describeFailure(failure, subject);
  return (
    <section className="app__section app__trouble" data-trouble={note.kind}>
      <h2 className="app__trouble-title">{note.heading}</h2>
      {note.steps}
      <p className="app__error">{note.detail}</p>
      <button type="button" className="app__up" onClick={onRetry}>
        Retry
      </button>
    </section>
  );
}
