//! One authenticated request to a Google API, with the 401 retry the contract
//! asks for and Google's error statuses turned into [`Trouble`].

use super::auth::Tokens;
use super::{Result, Trouble};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(20);
const USER_AGENT: &str = concat!("OpenKaava/", env!("CARGO_PKG_VERSION"));

pub enum Verb {
    Get,
    Post,
}

pub struct Reply {
    pub body: Vec<u8>,
    /// `x-goog-generation`, present on object downloads.
    pub generation: Option<i64>,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .http_status_as_error(false)
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .provider(ureq::tls::TlsProvider::NativeTls)
                .build(),
        )
        .user_agent(USER_AGENT)
        .build()
        .into()
}

/// `what` names the thing asked for, for the `Missing` a 404 becomes.
/// `range` is an HTTP `Range` value such as `bytes=-4194304`.
pub fn send(
    tokens: &Tokens,
    verb: Verb,
    url: &str,
    what: &str,
    range: Option<&str>,
    limit: u64,
) -> Result<Reply> {
    let mut retried = false;
    loop {
        let token = tokens.access()?;
        let bearer = format!("Bearer {token}");
        let agent = agent();
        let result = match verb {
            Verb::Get => {
                let mut request = agent.get(url).header("Authorization", &bearer);
                if let Some(range) = range {
                    request = request.header("Range", range);
                }
                request.call()
            }
            Verb::Post => agent
                .post(url)
                .header("Authorization", &bearer)
                .send_empty(),
        };
        let mut response = result.map_err(|err| Trouble::Unreachable {
            detail: err.to_string(),
        })?;

        let status = response.status().as_u16();
        if status == 401 && !retried {
            tokens.forget();
            retried = true;
            continue;
        }

        let generation = response
            .headers()
            .get("x-goog-generation")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok());
        let body = response
            .body_mut()
            .with_config()
            .limit(limit)
            .read_to_vec()
            .map_err(|err| Trouble::Unreachable {
                detail: err.to_string(),
            })?;

        return match status {
            200..=299 => Ok(Reply { body, generation }),
            401 => Err(Trouble::SignedOut {
                detail: "Google rejected a fresh token".into(),
            }),
            403 => Err(Trouble::Denied {
                detail: api_message(&body),
            }),
            404 => Err(Trouble::Missing { what: what.into() }),
            _ => Err(Trouble::Api {
                status,
                detail: api_message(&body),
            }),
        };
    }
}

/// `error.message` out of a Google error body, or a short fallback.
pub fn api_message(body: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| "no detail".into())
}

/// Percent-encode one URL component (RFC 3986 unreserved characters pass).
pub fn encode(part: &str) -> String {
    let mut out = String::with_capacity(part.len());
    for byte in part.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_escapes_slashes_and_spaces() {
        assert_eq!(encode("a/b c.json"), "a%2Fb%20c.json");
        assert_eq!(encode("labels.role=agent"), "labels.role%3Dagent");
    }

    #[test]
    fn api_message_reads_googles_error_shape() {
        let body = br#"{"error":{"code":403,"message":"no storage.objects.list"}}"#;
        assert_eq!(api_message(body), "no storage.objects.list");
        assert_eq!(api_message(b"<html>"), "no detail");
    }
}
