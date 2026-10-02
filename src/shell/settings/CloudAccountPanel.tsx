/**
 * The Google account OpenKaava signs in with, for the Cloud section.
 *
 * ## Why this is a panel and not a setting
 *
 * The second exception to "every section is drawn from the schema", for the
 * reason the GitHub section gives for leaving its token out: a setting is
 * written to `settings.json` in the clear and broadcast to every app frame. A
 * sign-in is a refresh token, and an OAuth client secret is a credential too,
 * so both go to Windows Credential Manager through their own commands, and
 * neither is ever read back here. What the panel shows is `GoogleAuthStatus`:
 * which halves of the client are set, and the account's email.
 *
 * The client ID is an ordinary setting below this panel. It is not a secret,
 * and keeping it a setting means a reset or a search finds it like any other.
 */
import { useCallback, useEffect, useState } from "react";
import {
  googleAuthStatus,
  googleCancelSignIn,
  googleSignIn,
  googleSignOut,
  onSettingsChanged,
  setGoogleClientSecret,
  type GoogleAuthStatus,
} from "../../bindings";

export default function CloudAccountPanel() {
  const [status, setStatus] = useState<GoogleAuthStatus | null>(null);
  const [busy, setBusy] = useState<"signIn" | "signOut" | "secret" | null>(null);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    return googleAuthStatus()
      .then(setStatus)
      .catch((err: unknown) => setError(String(err)));
  }, []);

  useEffect(() => {
    void load();
    // The client ID is a setting, and changing it changes whether a stored
    // sign-in still counts, so the status follows every settings change.
    const subscription = onSettingsChanged(() => void load());
    return () => {
      void subscription.then((unlisten) => {
        unlisten();
      });
    };
  }, [load]);

  const run = (what: typeof busy, action: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    void action()
      .catch((err: unknown) => setError(String(err)))
      .finally(() => {
        setBusy(null);
        void load();
      });
  };

  const saveSecret = () => {
    const trimmed = secret.trim();
    if (trimmed === "" || busy !== null) return;
    run("secret", () => setGoogleClientSecret(trimmed).then(() => setSecret("")));
  };

  if (status === null) {
    return (
      <div className="settings-cloud">
        <p className="settings-cloud__line">Reading the Google account…</p>
        {error && (
          <p className="settings-cloud__error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  const signingIn = busy === "signIn" || status.pending;

  return (
    <div className="settings-cloud">
      <div className="setting">
        <div className="setting__label">
          <span className="setting__title">Google account</span>
          <span className="setting__description">
            {status.email !== null
              ? `Signed in as ${status.email}. OpenKaava sends this account's ID token to the gateway.`
              : signingIn
                ? "Waiting for the browser. Approve the sign-in there, then come back."
                : status.configured
                  ? "Not signed in. The browser opens Google's own sign-in page."
                  : "Set the client ID below and the client secret here first."}
          </span>
        </div>
        <div className="setting__control">
          {status.email !== null ? (
            <button
              type="button"
              className="k-btn k-btn--secondary k-btn--sm"
              disabled={busy !== null}
              onClick={() => run("signOut", googleSignOut)}
            >
              {busy === "signOut" ? "Signing out…" : "Sign out"}
            </button>
          ) : signingIn ? (
            <button
              type="button"
              className="k-btn k-btn--secondary k-btn--sm"
              onClick={() => void googleCancelSignIn()}
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="k-btn k-btn--primary k-btn--sm"
              disabled={!status.configured || busy !== null}
              onClick={() => run("signIn", googleSignIn)}
            >
              Sign in with Google
            </button>
          )}
        </div>
        <div className="setting__reset-slot" />
      </div>

      <div className="setting">
        <div className="setting__label">
          <span className="setting__title">Client secret</span>
          <span className="setting__description">
            {status.hasClientSecret
              ? "Stored in Windows Credential Manager, not in the settings file. Paste a new one to replace it."
              : "From the OAuth client in the Google Cloud console. Stored in Windows Credential Manager, not in the settings file."}
          </span>
        </div>
        <div className="setting__control settings-cloud__secret">
          <input
            className="k-field__input k-field__input--mono settings-field"
            type="password"
            value={secret}
            spellCheck={false}
            autoComplete="off"
            placeholder={status.hasClientSecret ? "Stored" : "GOCSPX-…"}
            aria-label="Google OAuth client secret"
            onChange={(event) => setSecret(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveSecret();
            }}
          />
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            disabled={busy !== null || secret.trim() === ""}
            onClick={saveSecret}
          >
            Save
          </button>
          {status.hasClientSecret && (
            <button
              type="button"
              className="k-btn k-btn--ghost k-btn--sm"
              disabled={busy !== null}
              onClick={() => run("secret", () => setGoogleClientSecret(""))}
            >
              Clear
            </button>
          )}
        </div>
        <div className="setting__reset-slot" />
      </div>

      {error && (
        <p className="settings-cloud__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
