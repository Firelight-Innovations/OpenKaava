//! The `kaava-api` gateway (`services/kaava-api`): how OpenKaava reaches Plane
//! without an IAP tunnel, a hosts entry or the Plane token on the laptop.
//!
//! Every call carries a Google ID token: OpenKaava's own sign-in when there is
//! one ([`super::google`]), otherwise `gcloud auth print-identity-token`. Cloud
//! Run checks it before the service sees the request. The gateway marks its own
//! replies with `X-Kaava-Api: 1`, so a 401 or 403 without that header is Cloud
//! Run refusing the identity, and one with it is the service speaking.

use super::google::Client;
use super::{http, Cloud, Result, Trouble};
use serde_json::Value;

const MARKER: &str = "x-kaava-api";
const REPLY_LIMIT: u64 = 8 << 20;

/// Where the gateway is and which OAuth client the sign-in uses, both from
/// settings. An empty URL means not deployed yet.
#[derive(Clone)]
pub struct Gateway {
    pub url: String,
    pub client_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verb {
    Get,
    Post,
    Patch,
}

/// Which identity a call went out with, so a refusal names the right fix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Identity {
    Google,
    Gcloud,
}

impl Gateway {
    pub fn is_configured(&self) -> bool {
        !self.url.trim().is_empty()
    }

    fn endpoint(&self, path: &str, query: &[(String, String)]) -> Result<String> {
        let base = self.url.trim().trim_end_matches('/');
        if base.is_empty() {
            return Err(Trouble::GatewayUnconfigured);
        }
        if !base.starts_with("https://") && !base.starts_with("http://127.0.0.1:") {
            return Err(Trouble::GatewayUnreachable {
                detail: format!("the gateway URL must start with https:// (it is {base})"),
            });
        }
        let mut url = format!("{base}/{}", path.trim_start_matches('/'));
        for (i, (key, value)) in query.iter().enumerate() {
            url.push(if i == 0 { '?' } else { '&' });
            url.push_str(&http::encode(key));
            url.push('=');
            url.push_str(&http::encode(value));
        }
        Ok(url)
    }
}

/// An ID token for the gateway, and which identity it belongs to.
fn token(cloud: &Cloud, gateway: &Gateway) -> Result<(String, Identity)> {
    if let Some(client) = signed_in_client(cloud, gateway) {
        if let Some(token) = cloud.google.id_token(&client)? {
            return Ok((token, Identity::Google));
        }
    }
    Ok((cloud.tokens.identity()?, Identity::Gcloud))
}

fn signed_in_client(cloud: &Cloud, gateway: &Gateway) -> Option<Client> {
    let client = cloud.google.client(&gateway.client_id)?;
    cloud.google.is_signed_in(&client.id).then_some(client)
}

fn forget(cloud: &Cloud, identity: Identity) {
    match identity {
        Identity::Google => cloud.google.forget_id_token(),
        Identity::Gcloud => cloud.tokens.forget_identity(),
    }
}

/// One call. A refusal by Cloud Run is retried once with a fresh token, the
/// same rule `http::send` keeps for Google APIs.
pub fn call(
    cloud: &Cloud,
    gateway: &Gateway,
    verb: Verb,
    path: &str,
    query: &[(String, String)],
    body: Option<Value>,
) -> Result<Value> {
    let url = gateway.endpoint(path, query)?;
    let mut retried = false;
    loop {
        let (token, identity) = token(cloud, gateway)?;
        let (status, marked, bytes) = send(&url, &token, verb, body.clone())?;
        if (200..300).contains(&status) {
            if bytes.is_empty() {
                return Ok(Value::Null);
            }
            return serde_json::from_slice(&bytes).map_err(|e| Trouble::Api {
                status,
                detail: format!("unreadable gateway reply: {e}"),
            });
        }
        if !marked && matches!(status, 401 | 403) && !retried {
            forget(cloud, identity);
            retried = true;
            continue;
        }
        return Err(classify(status, marked, &bytes, identity));
    }
}

fn send(url: &str, token: &str, verb: Verb, body: Option<Value>) -> Result<(u16, bool, Vec<u8>)> {
    let bearer = format!("Bearer {token}");
    let agent = http::agent();
    // One expression per arm, as in `plane.rs`: ureq 3's request builders
    // with and without a body are different types.
    let result = match (verb, body) {
        (Verb::Get, _) => agent.get(url).header("Authorization", &bearer).call(),
        (Verb::Post, Some(json)) => agent
            .post(url)
            .header("Authorization", &bearer)
            .send_json(json),
        (Verb::Post, None) => agent
            .post(url)
            .header("Authorization", &bearer)
            .send_empty(),
        (Verb::Patch, Some(json)) => agent
            .patch(url)
            .header("Authorization", &bearer)
            .send_json(json),
        (Verb::Patch, None) => agent
            .patch(url)
            .header("Authorization", &bearer)
            .send_empty(),
    };
    // The transport error names the host and the failure, never the header.
    let mut response = result.map_err(|e| Trouble::GatewayUnreachable {
        detail: e.to_string(),
    })?;
    let status = response.status().as_u16();
    let marked = response.headers().contains_key(MARKER);
    let bytes = response
        .body_mut()
        .with_config()
        .limit(REPLY_LIMIT)
        .read_to_vec()
        .map_err(|e| Trouble::GatewayUnreachable {
            detail: e.to_string(),
        })?;
    Ok((status, marked, bytes))
}

/// `GET /v1/plane/status` and `POST /v1/plane/wake` both answer this.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct PlaneStatus {
    /// Compute Engine's status for plane-vm: `RUNNING`, `TERMINATED`, …
    pub vm: String,
    pub healthy: bool,
    pub detail: String,
}

fn typed<T: serde::de::DeserializeOwned>(value: Value, what: &str) -> Result<T> {
    serde_json::from_value(value).map_err(|e| Trouble::Api {
        status: 200,
        detail: format!("unreadable gateway reply for {what}: {e}"),
    })
}

/// plane-vm's state and Plane's health. Never wakes anything.
pub fn plane_status(cloud: &Cloud, gateway: &Gateway) -> Result<PlaneStatus> {
    typed(
        call(cloud, gateway, Verb::Get, "v1/plane/status", &[], None)?,
        "plane status",
    )
}

/// Start plane-vm if it is stopped. Answers at once; the caller polls status.
pub fn plane_wake(cloud: &Cloud, gateway: &Gateway) -> Result<PlaneStatus> {
    typed(
        call(cloud, gateway, Verb::Post, "v1/plane/wake", &[], None)?,
        "plane wake",
    )
}

/// The project records under one profile, as the bucket holds them. Each is
/// raw JSON: the caller parses them, so one bad record cannot hide the rest.
#[derive(Debug, serde::Deserialize)]
pub struct Records {
    pub projects: Vec<Value>,
    #[serde(default)]
    pub problems: Vec<String>,
}

pub fn project_records(cloud: &Cloud, gateway: &Gateway, profile: &str) -> Result<Records> {
    let query = [("profile".to_string(), profile.to_string())];
    typed(
        call(cloud, gateway, Verb::Get, "v1/projects", &query, None)?,
        "project records",
    )
}

/// A failed reply, in the words the frontend picks a screen by.
pub fn classify(status: u16, marked: bool, body: &[u8], identity: Identity) -> Trouble {
    if !marked {
        return match (status, identity) {
            (401, Identity::Google) => Trouble::SignInNeeded {
                detail: "the gateway did not accept OpenKaava's Google sign-in".into(),
            },
            (401, Identity::Gcloud) => Trouble::SignedOut {
                detail: "the gateway did not accept the gcloud identity".into(),
            },
            (403, _) => Trouble::Denied {
                detail: "this Google account may not call the gateway (run.invoker)".into(),
            },
            (404, _) => Trouble::GatewayUnreachable {
                detail: "nothing answers at the gateway URL; check Settings, Cloud".into(),
            },
            _ => Trouble::GatewayUnreachable {
                detail: format!("the gateway answered HTTP {status}"),
            },
        };
    }
    let reply: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let code = reply["error"].as_str().unwrap_or("");
    let detail = reply["detail"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| http::api_message(body));
    match (status, code) {
        (503, "plane_unreachable") => Trouble::PlaneAsleep { detail },
        (403, _) => Trouble::Denied { detail },
        (404, _) => Trouble::Missing { what: detail },
        (429, _) => Trouble::Unreachable {
            detail: format!("Plane's rate limit: {detail}"),
        },
        _ => Trouble::Api { status, detail },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn gateway(url: &str) -> Gateway {
        Gateway {
            url: url.into(),
            client_id: String::new(),
        }
    }

    #[test]
    fn an_empty_url_is_unconfigured_not_unreachable() {
        let err = gateway("  ").endpoint("v1/plane/status", &[]).unwrap_err();
        assert_eq!(err, Trouble::GatewayUnconfigured);
    }

    #[test]
    fn a_plain_http_url_is_refused_so_a_token_never_crosses_the_network_in_clear() {
        let err = gateway("http://kaava-api.example")
            .endpoint("v1/plane/status", &[])
            .unwrap_err();
        assert!(matches!(err, Trouble::GatewayUnreachable { .. }), "{err:?}");
    }

    #[test]
    fn the_endpoint_joins_the_path_and_encodes_the_query() {
        let url = gateway("https://kaava-api-x.a.run.app/")
            .endpoint(
                "/v1/plane/api/v1/workspaces/veistra/projects/",
                &[
                    ("per_page".into(), "100".into()),
                    ("q".into(), "a b".into()),
                ],
            )
            .unwrap();
        assert_eq!(
            url,
            "https://kaava-api-x.a.run.app/v1/plane/api/v1/workspaces/veistra/projects/?per_page=100&q=a%20b"
        );
    }

    #[test]
    fn cloud_runs_own_refusals_name_the_identity_that_was_refused() {
        assert!(matches!(
            classify(401, false, b"", Identity::Google),
            Trouble::SignInNeeded { .. }
        ));
        assert!(matches!(
            classify(401, false, b"", Identity::Gcloud),
            Trouble::SignedOut { .. }
        ));
        assert!(matches!(
            classify(403, false, b"<html>", Identity::Google),
            Trouble::Denied { .. }
        ));
    }

    #[test]
    fn the_services_own_codes_become_states() {
        let asleep = classify(
            503,
            true,
            br#"{"error":"plane_unreachable","detail":"Plane did not answer"}"#,
            Identity::Google,
        );
        assert_eq!(
            asleep,
            Trouble::PlaneAsleep {
                detail: "Plane did not answer".into()
            }
        );
        assert!(matches!(
            classify(
                403,
                true,
                br#"{"error":"not_allowed","detail":"x"}"#,
                Identity::Google
            ),
            Trouble::Denied { .. }
        ));
        assert!(matches!(
            classify(
                502,
                true,
                br#"{"error":"plane_auth","detail":"rotate"}"#,
                Identity::Google
            ),
            Trouble::Api { status: 502, .. }
        ));
        assert!(matches!(
            classify(
                429,
                true,
                br#"{"error":"rate_limited","detail":"wait"}"#,
                Identity::Google
            ),
            Trouble::Unreachable { .. }
        ));
    }

    /// The real HTTP path against a listener on loopback that plays the
    /// gateway: the bearer token arrives, the marked reply is parsed.
    #[test]
    fn a_call_sends_the_bearer_and_reads_the_reply() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 8192];
            let n = stream.read(&mut buf).unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            let body = r#"{"vm":"RUNNING","healthy":true,"detail":"healthy"}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nX-Kaava-Api: 1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            request
        });
        let (status, marked, bytes) = send(
            &format!("{base}/v1/plane/status"),
            "id-token-123",
            Verb::Get,
            None,
        )
        .unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /v1/plane/status "));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer id-token-123"));
        assert_eq!(status, 200);
        assert!(marked);
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["healthy"], true);
    }

    #[test]
    fn nothing_listening_is_unreachable_and_does_not_echo_the_token() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/plane/status", listener.local_addr().unwrap());
        drop(listener);
        let err = send(&url, "secret-id-token", Verb::Get, None).unwrap_err();
        assert!(matches!(err, Trouble::GatewayUnreachable { .. }), "{err:?}");
        assert!(!format!("{err:?}").contains("secret-id-token"));
    }
}
