//! Signing in to Google from OpenKaava itself, instead of through `gcloud`.
//!
//! An OAuth 2.0 installed-app flow (RFC 8252): the system browser opens
//! Google's consent page, Google redirects back to a one-shot listener on
//! `127.0.0.1`, and the code is exchanged with PKCE (RFC 7636). The scopes are
//! `openid` and `email` only, because the one thing this identity is for is an
//! ID token that Cloud Run (`kaava-api`) accepts.
//!
//! The refresh token and the OAuth client secret live in the OS credential
//! store ([`SecretStore`]); the ID token in memory only. The client ID is a
//! setting. `docs/cloud-services.md` §2 says why each lives where it does.
//!
//! No token is logged, put in an error, or handed to the frontend: every
//! error below carries Google's `error` code and description at most, and the
//! frontend sees [`Status`], which has an email and no token.

use super::{Result, Trouble};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const SCOPES: &str = "openid email";

/// How long the listener waits for the browser to come back.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Refresh this long before the ID token's own expiry, so a call does not
/// leave with a token that dies on the way.
const EARLY: Duration = Duration::from_secs(5 * 60);

/// Credential-store accounts, under the app's own keyring service.
const SESSION_ACCOUNT: &str = "google-signin";
const CLIENT_SECRET_ACCOUNT: &str = "google-oauth-client-secret";

/// The OAuth client: the ID from settings, the secret from the store.
#[derive(Clone)]
pub struct Client {
    pub id: String,
    pub secret: String,
}

/// Google's endpoints, overridable so a test can aim the exchange at a
/// listener on loopback.
#[derive(Clone)]
pub struct Endpoints {
    pub auth: String,
    pub token: String,
    pub revoke: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            auth: AUTH_URL.into(),
            token: TOKEN_URL.into(),
            revoke: REVOKE_URL.into(),
        }
    }
}

// --- the credential store ---------------------------------------------------

/// Where the refresh token and the client secret are kept. The real one is
/// the OS credential store; tests use [`MemoryStore`] so they never touch it.
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Option<String>;
    fn set(&self, account: &str, value: &str) -> std::result::Result<(), String>;
    fn delete(&self, account: &str) -> std::result::Result<(), String>;
}

/// Windows Credential Manager (or the platform's equivalent), under the same
/// service name the GitHub token already uses.
pub struct KeyringStore;

impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> Option<String> {
        keyring::Entry::new(crate::plugins::install::KEYRING_SERVICE, account)
            .ok()?
            .get_password()
            .ok()
            .filter(|v| !v.trim().is_empty())
    }

    fn set(&self, account: &str, value: &str) -> std::result::Result<(), String> {
        keyring::Entry::new(crate::plugins::install::KEYRING_SERVICE, account)
            .and_then(|e| e.set_password(value))
            .map_err(|e| format!("the credential store refused the write: {e}"))
    }

    fn delete(&self, account: &str) -> std::result::Result<(), String> {
        let entry = keyring::Entry::new(crate::plugins::install::KEYRING_SERVICE, account)
            .map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// The tests' store, so no test reads or writes the real credential store.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, String>>);

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(account)
            .cloned()
    }
    fn set(&self, account: &str, value: &str) -> std::result::Result<(), String> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(account.into(), value.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> std::result::Result<(), String> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(account);
        Ok(())
    }
}

/// What is stored per sign-in. The client ID is kept so that changing the
/// client in settings reads as signed out rather than as a refresh failure.
#[derive(Serialize, Deserialize)]
struct Stored {
    refresh_token: String,
    email: String,
    client_id: String,
}

// --- the state the app holds ------------------------------------------------

/// What the Settings panel draws. No token in here, by construction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// A client ID is set and a client secret is stored.
    pub configured: bool,
    pub has_client_id: bool,
    pub has_client_secret: bool,
    /// The signed-in Google account, if any.
    pub email: Option<String>,
    /// A sign-in is waiting for the browser.
    pub pending: bool,
}

pub struct GoogleAuth {
    store: Box<dyn SecretStore>,
    endpoints: Endpoints,
    /// The ID token and when it stops being worth sending.
    id_token: Mutex<Option<(String, Instant)>>,
    pending: AtomicBool,
    cancel: AtomicBool,
}

impl Default for GoogleAuth {
    fn default() -> Self {
        Self::new(Box::new(KeyringStore), Endpoints::default())
    }
}

impl GoogleAuth {
    pub fn new(store: Box<dyn SecretStore>, endpoints: Endpoints) -> Self {
        Self {
            store,
            endpoints,
            id_token: Mutex::new(None),
            pending: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
        }
    }

    /// The client, when both halves are present.
    pub fn client(&self, client_id: &str) -> Option<Client> {
        let id = client_id.trim();
        let secret = self.store.get(CLIENT_SECRET_ACCOUNT)?;
        (!id.is_empty()).then(|| Client {
            id: id.to_string(),
            secret,
        })
    }

    /// Store the client secret, or clear it with an empty string.
    pub fn set_client_secret(&self, secret: &str) -> std::result::Result<(), String> {
        if secret.trim().is_empty() {
            self.store.delete(CLIENT_SECRET_ACCOUNT)
        } else {
            self.store.set(CLIENT_SECRET_ACCOUNT, secret.trim())
        }
    }

    fn stored(&self, client_id: &str) -> Option<Stored> {
        let text = self.store.get(SESSION_ACCOUNT)?;
        let stored: Stored = serde_json::from_str(&text).ok()?;
        (stored.client_id == client_id.trim()).then_some(stored)
    }

    /// No network: what is configured and who is signed in.
    pub fn status(&self, client_id: &str) -> Status {
        let has_client_id = !client_id.trim().is_empty();
        let has_client_secret = self.store.get(CLIENT_SECRET_ACCOUNT).is_some();
        Status {
            configured: has_client_id && has_client_secret,
            has_client_id,
            has_client_secret,
            email: self.stored(client_id).map(|s| s.email),
            pending: self.pending.load(Ordering::SeqCst),
        }
    }

    pub fn is_signed_in(&self, client_id: &str) -> bool {
        self.stored(client_id).is_some()
    }

    /// Stop a sign-in that is waiting for the browser.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    /// Drop the cached ID token after the service refused it, so the next
    /// call refreshes.
    pub fn forget_id_token(&self) {
        *self.id_token.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// The whole browser round trip. `open` is handed the consent URL (the
    /// app passes the system browser opener). Returns the signed-in email.
    pub fn sign_in(
        &self,
        client: &Client,
        open: impl FnOnce(&str) -> std::result::Result<(), String>,
    ) -> std::result::Result<String, String> {
        if self.pending.swap(true, Ordering::SeqCst) {
            return Err("a sign-in is already waiting for the browser".into());
        }
        self.cancel.store(false, Ordering::SeqCst);
        let result = self.sign_in_inner(client, open);
        self.pending.store(false, Ordering::SeqCst);
        result
    }

    fn sign_in_inner(
        &self,
        client: &Client,
        open: impl FnOnce(&str) -> std::result::Result<(), String>,
    ) -> std::result::Result<String, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("could not listen on loopback: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("could not read the loopback port: {e}"))?
            .port();
        let redirect = format!("http://127.0.0.1:{port}");
        let verifier = random_token();
        let state = random_token();
        let url = consent_url(
            &self.endpoints.auth,
            &client.id,
            &redirect,
            &verifier,
            &state,
        )?;

        open(&url)?;
        let code = wait_for_code(&listener, &state, SIGN_IN_TIMEOUT, &self.cancel)?;

        let reply = post_token(
            &self.endpoints.token,
            &[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("code_verifier", &verifier),
                ("redirect_uri", &redirect),
                ("client_id", &client.id),
                ("client_secret", &client.secret),
            ],
        )?;
        let refresh = reply
            .refresh_token
            .ok_or("Google returned no refresh token; sign in again")?;
        let id_token = reply.id_token.ok_or("Google returned no ID token")?;
        let email = email_of(&id_token).ok_or("Google's ID token carried no email")?;

        let stored = Stored {
            refresh_token: refresh,
            email: email.clone(),
            client_id: client.id.clone(),
        };
        let text = serde_json::to_string(&stored).map_err(|e| e.to_string())?;
        self.store.set(SESSION_ACCOUNT, &text)?;
        self.keep(id_token, reply.expires_in);
        Ok(email)
    }

    fn keep(&self, id_token: String, expires_in: Option<u64>) {
        let lifetime = Duration::from_secs(expires_in.unwrap_or(3600)).saturating_sub(EARLY);
        *self.id_token.lock().unwrap_or_else(|e| e.into_inner()) =
            Some((id_token, Instant::now() + lifetime));
    }

    /// An ID token for `kaava-api`, refreshed when it is near expiry.
    /// `Ok(None)` means nobody is signed in with this client, which the
    /// caller may answer with the `gcloud` fallback.
    pub fn id_token(&self, client: &Client) -> Result<Option<String>> {
        {
            let slot = self.id_token.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((token, until)) = slot.as_ref() {
                if Instant::now() < *until && self.is_signed_in(&client.id) {
                    return Ok(Some(token.clone()));
                }
            }
        }
        let Some(stored) = self.stored(&client.id) else {
            return Ok(None);
        };
        let reply = post_token(
            &self.endpoints.token,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &stored.refresh_token),
                ("client_id", &client.id),
                ("client_secret", &client.secret),
            ],
        );
        let reply = match reply {
            Ok(reply) => reply,
            Err(detail) if detail.starts_with("invalid_grant") => {
                // Revoked, expired or the password changed: the stored token
                // is dead, so forget it and say the person must sign in again.
                let _ = self.store.delete(SESSION_ACCOUNT);
                self.forget_id_token();
                return Err(Trouble::SignInNeeded { detail });
            }
            Err(detail) => return Err(Trouble::Unreachable { detail }),
        };
        let token = reply.id_token.ok_or_else(|| Trouble::Api {
            status: 200,
            detail: "Google's refresh returned no ID token".into(),
        })?;
        self.keep(token.clone(), reply.expires_in);
        Ok(Some(token))
    }

    /// Revoke at Google (best effort), then forget locally. Local forgetting
    /// happens whatever the network says.
    pub fn sign_out(&self) -> std::result::Result<(), String> {
        if let Some(text) = self.store.get(SESSION_ACCOUNT) {
            if let Ok(stored) = serde_json::from_str::<Stored>(&text) {
                let _ = super::http::agent()
                    .post(&self.endpoints.revoke)
                    .send_form([("token", stored.refresh_token.as_str())]);
            }
        }
        self.forget_id_token();
        self.store.delete(SESSION_ACCOUNT)
    }
}

// --- the pure pieces ----------------------------------------------------------

/// 32 random bytes, base64url without padding: 43 characters, inside PKCE's
/// 43–128 range and usable as the `state` too.
pub fn random_token() -> String {
    let bytes: [u8; 32] = rand::random();
    URL_SAFE_NO_PAD.encode(bytes)
}

/// RFC 7636 §4.2, `S256`.
pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn consent_url(
    auth: &str,
    client_id: &str,
    redirect: &str,
    verifier: &str,
    state: &str,
) -> std::result::Result<String, String> {
    let mut url =
        url::Url::parse(auth).map_err(|_| format!("not an authorization endpoint: {auth}"))?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPES)
        .append_pair("code_challenge", &challenge(verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        // A refresh token, every time: without `consent`, a second sign-in
        // with the same account returns none and the session cannot outlive
        // the hour.
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    Ok(url.into())
}

/// What the browser brought back on the redirect.
#[derive(Debug, PartialEq, Eq)]
pub enum Redirect {
    Code(String),
    /// Google said no: `access_denied` when the person pressed Cancel.
    Refused(String),
    /// A request that is not the redirect (a favicon), to be answered and ignored.
    Other,
}

/// Read the redirect's request line. `expected_state` must match, or the code
/// is refused: that is what stops another page from completing this sign-in.
pub fn parse_redirect(
    request_line: &str,
    expected_state: &str,
) -> std::result::Result<Redirect, String> {
    let target = request_line.split_whitespace().nth(1).unwrap_or("");
    let url = url::Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| "the browser sent a malformed redirect".to_string())?;
    if url.path() != "/" {
        return Ok(Redirect::Other);
    }
    let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
    if let Some(error) = params.get("error") {
        return Ok(Redirect::Refused(error.clone()));
    }
    if params.get("state").map(String::as_str) != Some(expected_state) {
        return Err("the sign-in reply did not match this request; try again".into());
    }
    params
        .get("code")
        .cloned()
        .map(Redirect::Code)
        .ok_or_else(|| "the sign-in reply had no code".into())
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>OpenKaava</title>\
<body style=\"font:16px system-ui;margin:3em\"><h1>Signed in</h1>\
<p>You can close this tab and return to OpenKaava.</p></body>";
const REFUSED_PAGE: &str = "<!doctype html><meta charset=utf-8><title>OpenKaava</title>\
<body style=\"font:16px system-ui;margin:3em\"><h1>Not signed in</h1>\
<p>Return to OpenKaava to try again.</p></body>";

fn answer(stream: &mut TcpStream, status: &str, body: &str) {
    let reply = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(reply.as_bytes());
}

/// Accept connections on the loopback listener until the redirect arrives,
/// the deadline passes, or `cancel` is set.
fn wait_for_code(
    listener: &TcpListener,
    state: &str,
    timeout: Duration,
    cancel: &AtomicBool,
) -> std::result::Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("could not poll the loopback listener: {e}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("sign-in cancelled".into());
        }
        if Instant::now() >= deadline {
            return Err("the browser did not come back within five minutes".into());
        }
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(format!("the loopback listener failed: {e}")),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut line = String::new();
        if BufReader::new(&stream).read_line(&mut line).is_err() {
            continue;
        }
        match parse_redirect(&line, state) {
            Ok(Redirect::Code(code)) => {
                answer(&mut stream, "200 OK", DONE_PAGE);
                return Ok(code);
            }
            Ok(Redirect::Refused(error)) => {
                answer(&mut stream, "200 OK", REFUSED_PAGE);
                return Err(format!("Google sign-in was refused ({error})"));
            }
            Ok(Redirect::Other) => answer(&mut stream, "404 Not Found", ""),
            Err(message) => {
                answer(&mut stream, "400 Bad Request", REFUSED_PAGE);
                return Err(message);
            }
        }
    }
}

#[derive(Deserialize)]
struct TokenReply {
    id_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

#[derive(Deserialize)]
struct TokenError {
    error: String,
    #[serde(default)]
    error_description: String,
}

/// One form POST to the token endpoint. An error names Google's `error` code
/// first (callers match on `invalid_grant`) and its description, and never
/// any part of the request.
fn post_token(url: &str, form: &[(&str, &str)]) -> std::result::Result<TokenReply, String> {
    let mut response = super::http::agent()
        .post(url)
        .send_form(form.iter().copied())
        .map_err(|e| format!("Google's token endpoint did not answer: {e}"))?;
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .with_config()
        .limit(1 << 16)
        .read_to_vec()
        .map_err(|e| format!("Google's token endpoint did not answer: {e}"))?;
    if (200..300).contains(&status) {
        return serde_json::from_slice(&body)
            .map_err(|_| "Google's token endpoint sent an unreadable reply".to_string());
    }
    match serde_json::from_slice::<TokenError>(&body) {
        Ok(e) if e.error_description.is_empty() => Err(e.error),
        Ok(e) => Err(format!("{}: {}", e.error, e.error_description)),
        Err(_) => Err(format!("Google's token endpoint answered HTTP {status}")),
    }
}

/// The `email` claim of an ID token, without checking its signature. That is
/// fine for display and for the account label: the token came straight from
/// Google's token endpoint over TLS (OpenID Connect Core §3.1.3.7).
pub fn email_of(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    claims["email"].as_str().map(str::to_string)
}

// --- Tauri commands -------------------------------------------------------------

/// The client ID from settings.
fn client_id(app: &tauri::AppHandle) -> String {
    crate::settings::text(app, crate::settings::keys::CLOUD_GOOGLE_CLIENT_ID)
}

#[tauri::command]
pub fn google_auth_status(app: tauri::AppHandle) -> Status {
    use tauri::Manager;
    app.state::<super::Cloud>().google.status(&client_id(&app))
}

/// Store the OAuth client's secret in the credential store, or clear it with
/// an empty string. Never read back by the frontend.
#[tauri::command]
pub fn set_google_client_secret(
    app: tauri::AppHandle,
    secret: String,
) -> std::result::Result<(), String> {
    use tauri::Manager;
    app.state::<super::Cloud>()
        .google
        .set_client_secret(&secret)
}

/// Open the browser and wait for the person to approve. Answers the email.
#[tauri::command]
pub async fn google_sign_in(app: tauri::AppHandle) -> std::result::Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        use tauri_plugin_opener::OpenerExt;
        let cloud = app.state::<super::Cloud>();
        let client = cloud
            .google
            .client(&client_id(&app))
            .ok_or("set the Google OAuth client ID and client secret in Settings, Cloud, first")?;
        cloud.google.sign_in(&client, |url| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|e| format!("could not open the browser: {e}"))
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn google_cancel_sign_in(app: tauri::AppHandle) {
    use tauri::Manager;
    app.state::<super::Cloud>().google.cancel();
}

#[tauri::command]
pub async fn google_sign_out(app: tauri::AppHandle) -> std::result::Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        app.state::<super::Cloud>().google.sign_out()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn jwt(claims: serde_json::Value) -> String {
        format!(
            "{}.{}.sig",
            URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256"}"#),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        )
    }

    /// A token endpoint on loopback that answers each request from `replies`
    /// in turn and hands back the bodies it was sent.
    fn token_server(
        replies: Vec<(&'static str, String)>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for (status, body) in replies {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = vec![0u8; 8192];
                let mut read = 0;
                // Read until the whole form body has arrived.
                loop {
                    let n = stream.read(&mut buf[read..]).unwrap();
                    read += n;
                    let text = String::from_utf8_lossy(&buf[..read]).to_string();
                    if let Some(split) = text.find("\r\n\r\n") {
                        let length = text
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if read >= split + 4 + length || n == 0 {
                            seen.push(text[split + 4..].to_string());
                            break;
                        }
                    }
                }
                let reply = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(reply.as_bytes()).unwrap();
            }
            seen
        });
        (url, handle)
    }

    fn auth_with(token_url: &str) -> GoogleAuth {
        let store = MemoryStore::default();
        store.set(CLIENT_SECRET_ACCOUNT, "client-secret").unwrap();
        GoogleAuth::new(
            Box::new(store),
            Endpoints {
                auth: AUTH_URL.into(),
                token: token_url.into(),
                revoke: "http://127.0.0.1:9/revoke".into(),
            },
        )
    }

    /// RFC 7636 appendix B.
    #[test]
    fn the_challenge_matches_the_rfc_example() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn random_tokens_are_pkce_sized_and_differ() {
        let a = random_token();
        assert_eq!(a.len(), 43);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(a, random_token());
    }

    #[test]
    fn the_consent_url_asks_for_pkce_offline_access_and_nothing_broader() {
        let url = consent_url(
            AUTH_URL,
            "cid.apps",
            "http://127.0.0.1:5555",
            "verifier",
            "st",
        )
        .unwrap();
        let parsed = url::Url::parse(&url).unwrap();
        let q: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "cid.apps");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5555");
        assert_eq!(q["scope"], "openid email");
        assert_eq!(q["code_challenge"], challenge("verifier"));
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["state"], "st");
        assert_eq!(q["access_type"], "offline");
        assert!(
            !url.contains("verifier&"),
            "the verifier itself never leaves"
        );
    }

    #[test]
    fn the_redirect_yields_its_code_only_with_the_right_state() {
        assert_eq!(
            parse_redirect("GET /?state=s1&code=4%2Fabc HTTP/1.1\r\n", "s1"),
            Ok(Redirect::Code("4/abc".into()))
        );
        assert!(parse_redirect("GET /?state=other&code=x HTTP/1.1", "s1").is_err());
        assert!(parse_redirect("GET /?code=x HTTP/1.1", "s1").is_err());
        assert_eq!(
            parse_redirect("GET /?error=access_denied&state=s1 HTTP/1.1", "s1"),
            Ok(Redirect::Refused("access_denied".into()))
        );
        assert_eq!(
            parse_redirect("GET /favicon.ico HTTP/1.1", "s1"),
            Ok(Redirect::Other)
        );
    }

    #[test]
    fn email_is_read_from_the_id_token() {
        let token = jwt(serde_json::json!({ "email": "b@x.com", "aud": "cid" }));
        assert_eq!(email_of(&token).as_deref(), Some("b@x.com"));
        assert_eq!(email_of("not-a-jwt"), None);
    }

    /// The whole flow against a fake browser and a fake token endpoint: the
    /// "browser" follows the consent URL's redirect with the state it was
    /// given, and the exchange carries the verifier whose challenge was sent.
    #[test]
    fn a_full_sign_in_stores_the_refresh_token_and_keeps_the_id_token_in_memory() {
        let id_token = jwt(serde_json::json!({ "email": "braden@example.com" }));
        let reply = serde_json::json!({
            "access_token": "ya29.access",
            "id_token": id_token,
            "refresh_token": "1//refresh",
            "expires_in": 3599,
        })
        .to_string();
        let (token_url, seen) = token_server(vec![("200 OK", reply)]);
        let auth = auth_with(&token_url);
        let client = auth.client("cid.apps").expect("configured");

        let email = auth
            .sign_in(&client, |consent| {
                let parsed = url::Url::parse(consent).unwrap();
                let q: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
                let redirect = q["redirect_uri"].clone();
                let state = q["state"].clone();
                std::thread::spawn(move || {
                    let target = redirect.trim_start_matches("http://");
                    let mut s = TcpStream::connect(target).unwrap();
                    write!(
                        s,
                        "GET /?state={state}&code=the-code HTTP/1.1\r\nHost: x\r\n\r\n"
                    )
                    .unwrap();
                    let mut page = String::new();
                    let _ = s.read_to_string(&mut page);
                    assert!(page.contains("Signed in"));
                });
                Ok(())
            })
            .unwrap();
        assert_eq!(email, "braden@example.com");

        let sent = seen.join().unwrap();
        assert!(sent[0].contains("grant_type=authorization_code"));
        assert!(sent[0].contains("code=the-code"));
        assert!(sent[0].contains("code_verifier="));
        assert!(sent[0].contains("client_secret=client-secret"));

        let status = auth.status("cid.apps");
        assert_eq!(status.email.as_deref(), Some("braden@example.com"));
        assert!(status.configured && !status.pending);
        let stored = auth.store.get(SESSION_ACCOUNT).unwrap();
        assert!(stored.contains("1//refresh"));
        assert!(
            !stored.contains("ya29") && !stored.contains(&id_token),
            "only the refresh token is persisted"
        );
        assert_eq!(auth.id_token(&client).unwrap(), Some(id_token));
    }

    #[test]
    fn an_expired_id_token_is_refreshed_with_the_stored_refresh_token() {
        let fresh = jwt(serde_json::json!({ "email": "b@x.com", "n": 2 }));
        let (token_url, seen) = token_server(vec![(
            "200 OK",
            serde_json::json!({ "id_token": fresh, "expires_in": 3599 }).to_string(),
        )]);
        let auth = auth_with(&token_url);
        let stored = Stored {
            refresh_token: "1//r".into(),
            email: "b@x.com".into(),
            client_id: "cid".into(),
        };
        auth.store
            .set(SESSION_ACCOUNT, &serde_json::to_string(&stored).unwrap())
            .unwrap();
        let client = auth.client("cid").unwrap();
        assert_eq!(auth.id_token(&client).unwrap(), Some(fresh.clone()));
        // Cached now: a second call makes no request (the server answers once).
        assert_eq!(auth.id_token(&client).unwrap(), Some(fresh));
        let sent = seen.join().unwrap();
        assert!(sent[0].contains("grant_type=refresh_token"));
        assert!(sent[0].contains("refresh_token=1%2F%2Fr"));
    }

    #[test]
    fn a_revoked_refresh_token_signs_out_and_says_so_without_the_token() {
        let (token_url, seen) = token_server(vec![(
            "400 Bad Request",
            r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#
                .into(),
        )]);
        let auth = auth_with(&token_url);
        let stored = Stored {
            refresh_token: "1//secret-refresh".into(),
            email: "b@x.com".into(),
            client_id: "cid".into(),
        };
        auth.store
            .set(SESSION_ACCOUNT, &serde_json::to_string(&stored).unwrap())
            .unwrap();
        let client = auth.client("cid").unwrap();
        let err = auth.id_token(&client).unwrap_err();
        assert!(matches!(err, Trouble::SignInNeeded { .. }), "{err:?}");
        assert!(!format!("{err:?}").contains("secret-refresh"));
        assert!(!auth.is_signed_in("cid"));
        seen.join().unwrap();
    }

    #[test]
    fn nobody_signed_in_is_none_not_an_error() {
        let auth = auth_with("http://127.0.0.1:9/never-called");
        let client = auth.client("cid").unwrap();
        assert_eq!(auth.id_token(&client).unwrap(), None);
    }

    #[test]
    fn a_session_for_another_client_reads_as_signed_out() {
        let auth = auth_with("http://127.0.0.1:9/never-called");
        let stored = Stored {
            refresh_token: "r".into(),
            email: "b@x.com".into(),
            client_id: "old-client".into(),
        };
        auth.store
            .set(SESSION_ACCOUNT, &serde_json::to_string(&stored).unwrap())
            .unwrap();
        assert_eq!(auth.status("new-client").email, None);
        assert_eq!(auth.status("old-client").email.as_deref(), Some("b@x.com"));
    }

    #[test]
    fn status_names_what_is_missing() {
        let auth = GoogleAuth::new(Box::<MemoryStore>::default(), Endpoints::default());
        let status = auth.status("");
        assert!(!status.configured && !status.has_client_id && !status.has_client_secret);
        assert!(auth.client("cid").is_none(), "no secret yet");
        auth.set_client_secret("  s  ").unwrap();
        assert!(auth.status("cid").configured);
        assert_eq!(auth.client("cid").unwrap().secret, "s");
        auth.set_client_secret("").unwrap();
        assert!(!auth.status("cid").has_client_secret);
    }

    #[test]
    fn status_serializes_without_any_token_field() {
        let value = serde_json::to_value(Status {
            configured: true,
            has_client_id: true,
            has_client_secret: true,
            email: Some("b@x.com".into()),
            pending: false,
        })
        .unwrap();
        let keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "configured",
                "email",
                "hasClientId",
                "hasClientSecret",
                "pending"
            ]
        );
    }

    #[test]
    fn signing_out_forgets_locally_even_when_revoke_cannot_be_reached() {
        let auth = auth_with("http://127.0.0.1:9/never-called");
        let stored = Stored {
            refresh_token: "r".into(),
            email: "b@x.com".into(),
            client_id: "cid".into(),
        };
        auth.store
            .set(SESSION_ACCOUNT, &serde_json::to_string(&stored).unwrap())
            .unwrap();
        auth.sign_out().unwrap();
        assert!(!auth.is_signed_in("cid"));
    }

    #[test]
    fn a_cancelled_sign_in_stops_waiting() {
        let auth = auth_with("http://127.0.0.1:9/never-called");
        let client = auth.client("cid").unwrap();
        let err = auth
            .sign_in(&client, |_| {
                auth.cancel();
                Ok(())
            })
            .unwrap_err();
        assert_eq!(err, "sign-in cancelled");
        assert!(!auth.status("cid").pending);
    }
}
