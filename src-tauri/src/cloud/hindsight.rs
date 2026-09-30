//! Is Hindsight, the shared agent memory service, up and answering this user?
//!
//! `docs/cloud-services.md` §8: Hindsight is a Cloud Run service behind Google
//! IAM, reached with an ID token from `gcloud auth print-identity-token`. Every
//! request keeps a billed instance alive for about fifteen minutes, so this is
//! called once when someone opens the Hindsight page or presses "Check again",
//! never on a timer and never at startup.
//!
//! It reads `GET <url>/health` and nothing else. The recall and reflect API is
//! looked up from the service's own `openapi.json` after deploy and is not
//! restated here, so this module claims only what it checked: the service
//! answered, or why it did not.

use super::{auth::Tokens, http, Cloud, Result, Trouble};
use serde::Serialize;
use std::time::Instant;

/// Where the deployed service lives, from `docs/cloud-services.md` §1.
/// `KAAVA_HINDSIGHT_URL` overrides it, the same variable the agent VMs read.
pub const DEFAULT_URL: &str = "https://hindsight-hsi6ckovra-uc.a.run.app";

pub const URL_ENV: &str = "KAAVA_HINDSIGHT_URL";

pub fn base_url() -> String {
    std::env::var(URL_ENV)
        .ok()
        .map(|u| u.trim().trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| DEFAULT_URL.to_string())
}

/// What the page draws: the service answered, or why it did not. Never an
/// error to the caller, because a service being down is a state to show.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    #[serde(rename_all = "camelCase")]
    Connected { url: String, latency_ms: u64 },
    #[serde(rename_all = "camelCase")]
    Trouble { url: String, trouble: Trouble },
}

/// One `GET <url>/health` with `token`. Split from [`status`] so a test can aim
/// it at a local listener without `gcloud`.
pub fn ping(url: &str, token: &str) -> Result<u64> {
    let started = Instant::now();
    let response = http::agent()
        .get(&format!("{url}/health"))
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|err| Trouble::Unreachable {
            detail: err.to_string(),
        })?;
    match response.status().as_u16() {
        200..=299 => Ok(started.elapsed().as_millis() as u64),
        401 | 403 => Err(Trouble::Denied {
            detail: "Cloud Run refused this Google identity; it needs the run.invoker role on the Hindsight service".into(),
        }),
        404 => Err(Trouble::Missing {
            what: "the Hindsight service".into(),
        }),
        status => Err(Trouble::Api {
            status,
            detail: "Hindsight answered with an error".into(),
        }),
    }
}

/// Check the service. Blocking: call it from a worker thread.
pub fn status(cloud: &Cloud) -> Status {
    let url = base_url();
    match check(&cloud.tokens, &url) {
        Ok(latency_ms) => Status::Connected { url, latency_ms },
        Err(trouble) => Status::Trouble { url, trouble },
    }
}

fn check(tokens: &Tokens, url: &str) -> Result<u64> {
    let result = ping(url, &tokens.identity()?);
    if matches!(result, Err(Trouble::Denied { .. })) {
        // A token that went stale reads as a refusal; ask gcloud once more.
        tokens.forget_identity();
        return ping(url, &tokens.identity()?);
    }
    result
}

/// The page's one call. `async` with `spawn_blocking` because `gcloud` and the
/// request both block, and a plain command would run them on the main thread.
/// Always `Ok`: an unreachable service is a [`Status`], not an exception.
#[tauri::command]
pub async fn hindsight_status(app: tauri::AppHandle) -> std::result::Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        status(&app.state::<Cloud>())
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A listener that answers one request with `status`, and hands back the
    /// request it read so the test can check the bearer header went out.
    fn serve(status: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let n = stream.read(&mut buf).unwrap();
            let reply =
                format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            stream.write_all(reply.as_bytes()).unwrap();
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        (url, handle)
    }

    #[test]
    fn a_healthy_service_is_connected_and_gets_the_bearer_token() {
        let (url, request) = serve("200 OK");
        assert!(ping(&url, "abc").is_ok());
        let request = request.join().unwrap();
        assert!(request.starts_with("GET /health "), "{request}");
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer abc"));
    }

    #[test]
    fn a_refusal_is_denied_not_a_network_error() {
        let (url, _) = serve("403 Forbidden");
        assert!(matches!(ping(&url, "t"), Err(Trouble::Denied { .. })));
    }

    #[test]
    fn a_missing_service_is_missing() {
        let (url, _) = serve("404 Not Found");
        assert!(matches!(ping(&url, "t"), Err(Trouble::Missing { .. })));
    }

    #[test]
    fn a_server_error_carries_its_status() {
        let (url, _) = serve("503 Service Unavailable");
        assert!(matches!(
            ping(&url, "t"),
            Err(Trouble::Api { status: 503, .. })
        ));
    }

    #[test]
    fn nothing_listening_is_unreachable() {
        // Port 1 on loopback is closed; the connect is refused at once.
        assert!(matches!(
            ping("http://127.0.0.1:1", "t"),
            Err(Trouble::Unreachable { .. })
        ));
    }

    #[test]
    fn a_trouble_status_serializes_tagged_for_the_page() {
        let value = serde_json::to_value(Status::Trouble {
            url: "u".into(),
            trouble: Trouble::GcloudMissing,
        })
        .unwrap();
        assert_eq!(value["state"], "trouble");
        assert_eq!(value["trouble"]["kind"], "gcloudMissing");
    }
}
