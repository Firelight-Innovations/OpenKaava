//! Talking to Plane CE itself, over its own REST API — not a Google one.
//!
//! `OPENKAAVA-PLANE-DESIGN.md` §3 and §7.1: base `http://plane.kaava.internal:8765/api/v1/`,
//! auth header `X-API-Key`, cursor pagination with `per_page` at most
//! [`MAX_PER_PAGE`], and a 300-requests-per-minute budget per key (§12 V4).
//! The one secret this module ever holds is `plane-pat-kaava`, fetched from
//! Secret Manager into memory and never written to disk, a log, or handed to
//! the frontend — `apps/projects.rs` exposes [`call`] as `plane/get`,
//! `plane/post` and `plane/patch`, and none of those methods echo the token
//! back in an error or a value.

use super::http::{self, Verb};
use super::{is_plain_segment, Cloud, Result, Source, Trouble};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// design §3 / §7.1.
pub const BASE_URL: &str = "http://plane.kaava.internal:8765/api/v1/";
const SECRET_NAME: &str = "plane-pat-kaava";

/// design §6.2 / §12 V4: 300 requests/minute per key.
const RATE_LIMIT: usize = 300;
const RATE_WINDOW: Duration = Duration::from_secs(60);

/// design §7.1: cursor pagination, `per_page` at most 100.
pub const MAX_PER_PAGE: u32 = 100;

/// Never exceed the design's page size, whatever a caller asked for.
pub fn clamp_per_page(requested: u32) -> u32 {
    requested.min(MAX_PER_PAGE)
}

/// The one GET/POST/PATCH verb set `apps/projects.rs` exposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Patch,
}

/// Held on [`Cloud`]: the PAT once fetched, and the call budget. Both are
/// process-wide rather than per-call, for the reasons their fields say.
#[derive(Default)]
pub struct PlaneState {
    /// Fetched once per process; see [`pat`]. Never serialized — there is no
    /// `Serialize` impl on this struct at all, so a slip that tried to hand
    /// `Cloud` to the frontend whole would fail to compile rather than leak.
    pat: Mutex<Option<String>>,
    limiter: RateLimiter,
}

/// A path is safe to append to [`BASE_URL`] when every segment is a plain
/// name — the same rule [`is_plain_segment`] already enforces for a storage
/// object name, applied here so `plane/get` cannot be turned into a request
/// against an arbitrary host or a `../` escape out of `/api/v1/`. A trailing
/// slash (Plane's own list endpoints all have one) is allowed by treating the
/// empty segment it produces as fine.
pub fn is_safe_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains("..")
        && path
            .split('/')
            .all(|seg| seg.is_empty() || is_plain_segment(seg))
}

/// The PAT, fetched once per process and cached from then on. `source`
/// decides where from: Secret Manager live, or a fixture file for tests and
/// for building the UI before there is a real key to read.
fn pat(cloud: &Cloud, source: &Source) -> Result<String> {
    {
        let cached = cloud.plane.pat.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(token) = cached.as_ref() {
            return Ok(token.clone());
        }
    }
    let token = match source {
        Source::Live { project } => fetch_secret_live(cloud, project)?,
        Source::Fixture { root } => fetch_secret_fixture(root)?,
    };
    *cloud.plane.pat.lock().unwrap_or_else(|e| e.into_inner()) = Some(token.clone());
    Ok(token)
}

fn fetch_secret_live(cloud: &Cloud, project: &str) -> Result<String> {
    let url = format!(
        "https://secretmanager.googleapis.com/v1/projects/{}/secrets/{}/versions/latest:access",
        http::encode(project),
        http::encode(SECRET_NAME)
    );
    let reply = http::send(
        &cloud.tokens,
        Verb::Get,
        &url,
        &format!("secret {SECRET_NAME}"),
        None,
        1 << 16,
    )?;

    #[derive(serde::Deserialize)]
    struct Access {
        payload: Payload,
    }
    #[derive(serde::Deserialize)]
    struct Payload {
        data: String,
    }
    let parsed: Access = serde_json::from_slice(&reply.body).map_err(|e| Trouble::Api {
        status: 200,
        detail: format!("unreadable secret response: {e}"),
    })?;
    let decoded = STANDARD
        .decode(parsed.payload.data)
        .map_err(|e| Trouble::Api {
            status: 200,
            detail: format!("secret payload was not base64: {e}"),
        })?;
    String::from_utf8(decoded).map_err(|_| Trouble::Api {
        status: 200,
        detail: "secret payload was not UTF-8".into(),
    })
}

fn fetch_secret_fixture(root: &Path) -> Result<String> {
    let path = root.join("secrets").join(format!("{SECRET_NAME}.txt"));
    std::fs::read_to_string(&path)
        .map(|s| s.trim().to_string())
        .map_err(|e| Trouble::Fixture {
            detail: format!("{}: {e}", path.display()),
        })
}

/// One call to Plane's REST API. `path` and `query` are the caller's; `path`
/// must already satisfy [`is_safe_path`] (the app method checks it before
/// this is reached, and this checks again rather than trust a second call
/// site to remember to).
pub fn call(
    cloud: &Cloud,
    source: &Source,
    method: Method,
    path: &str,
    query: &[(String, String)],
    body: Option<Value>,
) -> Result<Value> {
    if !is_safe_path(path) {
        return Err(Trouble::Missing {
            what: format!("Plane path {path:?}"),
        });
    }
    match source {
        Source::Live { project } => call_live(cloud, project, method, path, query, body),
        Source::Fixture { root } => call_fixture(root, method, path),
    }
}

fn build_url(path: &str, query: &[(String, String)]) -> String {
    let mut url = format!("{BASE_URL}{path}");
    for (i, (key, value)) in query.iter().enumerate() {
        url.push(if i == 0 { '?' } else { '&' });
        url.push_str(&http::encode(key));
        url.push('=');
        url.push_str(&http::encode(value));
    }
    url
}

fn call_live(
    cloud: &Cloud,
    project: &str,
    method: Method,
    path: &str,
    query: &[(String, String)],
    body: Option<Value>,
) -> Result<Value> {
    let source = Source::Live {
        project: project.to_string(),
    };
    let token = pat(cloud, &source)?;
    cloud.plane.limiter.wait(std::thread::sleep);

    let url = build_url(path, query);
    let agent = http::agent();
    // Not built as one `RequestBuilder` and dispatched at the end: ureq 3
    // tracks "has a body yet" in the type itself (`RequestBuilder<WithoutBody>`
    // vs `<WithBody>`), so `.get()` and `.post()/.patch()` are two different
    // types a `match` cannot unify into one variable. Each arm below builds
    // and sends in the same expression instead, which only needs the *result*
    // — the same type on every arm — to unify.
    let result = match (method, body) {
        (Method::Get, _) => agent.get(&url).header("X-API-Key", &token).call(),
        (Method::Post, Some(json)) => agent.post(&url).header("X-API-Key", &token).send_json(json),
        (Method::Post, None) => agent.post(&url).header("X-API-Key", &token).send_empty(),
        (Method::Patch, Some(json)) => agent
            .patch(&url)
            .header("X-API-Key", &token)
            .send_json(json),
        (Method::Patch, None) => agent.patch(&url).header("X-API-Key", &token).send_empty(),
    };
    let mut response = result.map_err(|err| Trouble::Unreachable {
        detail: err.to_string(),
    })?;
    let status = response.status().as_u16();
    let bytes = response
        .body_mut()
        .with_config()
        .limit(8 << 20)
        .read_to_vec()
        .map_err(|e| Trouble::Unreachable {
            detail: e.to_string(),
        })?;

    match status {
        200..=299 if bytes.is_empty() => Ok(Value::Null),
        200..=299 => serde_json::from_slice(&bytes).map_err(|e| Trouble::Api {
            status,
            detail: format!("unreadable Plane response: {e}"),
        }),
        401 | 403 => Err(Trouble::Denied {
            detail: http::api_message(&bytes),
        }),
        404 => Err(Trouble::Missing {
            what: format!("Plane {path}"),
        }),
        429 => Err(Trouble::Unreachable {
            detail: "Plane's rate limit answered 429; back off before retrying".into(),
        }),
        _ => Err(Trouble::Api {
            status,
            detail: http::api_message(&bytes),
        }),
    }
}

/// A fixture answer for `plane/get|post|patch`, read from
/// `<root>/plane/<verb>/<path with '/' turned into '__'>.json`. Query and body
/// are not part of the fixture key: a fixture's job is a stable, hand-written
/// answer for one endpoint, not a mock of Plane's own filtering.
fn call_fixture(root: &Path, method: Method, path: &str) -> Result<Value> {
    let verb = match method {
        Method::Get => "get",
        Method::Post => "post",
        Method::Patch => "patch",
    };
    let name = path.trim_matches('/').replace('/', "__");
    let file = root.join("plane").join(verb).join(format!("{name}.json"));
    let text = std::fs::read_to_string(&file).map_err(|e| Trouble::Fixture {
        detail: format!("{}: {e}", file.display()),
    })?;
    serde_json::from_str(&text).map_err(|e| Trouble::Fixture {
        detail: format!("{}: {e}", file.display()),
    })
}

// --- rate limiting -------------------------------------------------------

/// A sliding window of the last minute's call timestamps, so a burst of app
/// methods cannot push Plane past the budget it agreed to. Blocking rather
/// than refusing: a caller waiting a few seconds behind an IAP tunnel is a
/// better experience than a caller who has to notice a `Trouble` and retry by
/// hand for something that was never actually denied.
struct RateLimiter {
    history: Mutex<VecDeque<Instant>>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self {
            history: Mutex::new(VecDeque::new()),
        }
    }
}

impl RateLimiter {
    /// Block, if the budget is spent, until there is room for one more call.
    /// `sleep` is injected so a test can assert on how long it *would* have
    /// waited without a real thread ever sleeping.
    fn wait(&self, sleep: impl Fn(Duration)) {
        loop {
            let now = Instant::now();
            let wait_for = {
                let mut history = self.history.lock().unwrap_or_else(|e| e.into_inner());
                admit(&mut history, now)
            };
            match wait_for {
                None => return,
                Some(duration) => sleep(duration),
            }
        }
    }
}

/// The pure decision behind [`RateLimiter::wait`]: given the recent call
/// times and now, either record this call and proceed (`None`), or say how
/// long until the oldest one falls out of the window (`Some`). Split out so
/// it is tested without a real clock or a real sleep.
fn admit(history: &mut VecDeque<Instant>, now: Instant) -> Option<Duration> {
    while let Some(&front) = history.front() {
        if now.duration_since(front) >= RATE_WINDOW {
            history.pop_front();
        } else {
            break;
        }
    }
    if history.len() < RATE_LIMIT {
        history.push_back(now);
        None
    } else {
        history
            .front()
            .map(|&front| RATE_WINDOW.saturating_sub(now.duration_since(front)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_root() -> (tempfile::TempDir, Source) {
        let dir = tempfile::tempdir().unwrap();
        let secrets = dir.path().join("secrets");
        std::fs::create_dir_all(&secrets).unwrap();
        std::fs::write(
            secrets.join("plane-pat-kaava.txt"),
            "plane_pat_test_token\n",
        )
        .unwrap();
        let plane_get = dir.path().join("plane").join("get");
        std::fs::create_dir_all(&plane_get).unwrap();
        std::fs::write(
            plane_get.join("workspaces__veistra__projects.json"),
            r#"{"results":[],"next_cursor":null}"#,
        )
        .unwrap();
        let source = Source::Fixture {
            root: dir.path().to_path_buf(),
        };
        (dir, source)
    }

    #[test]
    fn is_safe_path_accepts_plane_style_paths_and_refuses_traversal() {
        assert!(is_safe_path("workspaces/veistra/projects/"));
        assert!(is_safe_path("workspaces/veistra/projects/abc-123/issues/"));
        for bad in ["", "/workspaces", "workspaces/../secrets", "http://evil"] {
            assert!(!is_safe_path(bad), "{bad:?} must be refused");
        }
    }

    #[test]
    fn the_pat_is_cached_after_the_first_fixture_read() {
        let (_dir, source) = fixture_root();
        let cloud = Cloud::default();
        let first = pat(&cloud, &source).unwrap();
        assert_eq!(first, "plane_pat_test_token");
        // Delete the fixture file; a cached read must not need it again.
        std::fs::remove_file(match &source {
            Source::Fixture { root } => root.join("secrets").join("plane-pat-kaava.txt"),
            Source::Live { .. } => unreachable!(),
        })
        .unwrap();
        assert_eq!(pat(&cloud, &source).unwrap(), "plane_pat_test_token");
    }

    #[test]
    fn a_fixture_get_answers_from_the_matching_file() {
        let (_dir, source) = fixture_root();
        let cloud = Cloud::default();
        let value = call(
            &cloud,
            &source,
            Method::Get,
            "workspaces/veistra/projects/",
            &[],
            None,
        )
        .unwrap();
        assert_eq!(value["results"], serde_json::json!([]));
    }

    #[test]
    fn an_unsafe_path_is_refused_before_any_fixture_lookup() {
        let (_dir, source) = fixture_root();
        let cloud = Cloud::default();
        let err = call(&cloud, &source, Method::Get, "../escape", &[], None).unwrap_err();
        assert!(matches!(err, Trouble::Missing { .. }));
    }

    #[test]
    fn a_missing_fixture_file_is_a_fixture_trouble_not_a_panic() {
        let (_dir, source) = fixture_root();
        let cloud = Cloud::default();
        let err = call(
            &cloud,
            &source,
            Method::Get,
            "workspaces/veistra/nonesuch/",
            &[],
            None,
        )
        .unwrap_err();
        assert!(matches!(err, Trouble::Fixture { .. }));
    }

    #[test]
    fn per_page_is_never_widened_past_the_cap() {
        assert_eq!(clamp_per_page(50), 50);
        assert_eq!(clamp_per_page(100), 100);
        assert_eq!(clamp_per_page(500), MAX_PER_PAGE);
    }

    #[test]
    fn build_url_appends_an_encoded_query_string() {
        let url = build_url(
            "workspaces/veistra/projects/",
            &[("per_page".to_string(), "100".to_string())],
        );
        assert_eq!(
            url,
            format!("{BASE_URL}workspaces/veistra/projects/?per_page=100")
        );
    }

    #[test]
    fn admit_lets_the_budget_through_and_then_asks_for_a_wait() {
        let mut history = VecDeque::new();
        let start = Instant::now();
        for _ in 0..RATE_LIMIT {
            assert_eq!(admit(&mut history, start), None);
        }
        let wait = admit(&mut history, start).expect("the budget is spent");
        assert!(wait <= RATE_WINDOW && wait > Duration::ZERO);
    }

    #[test]
    fn admit_forgets_calls_older_than_the_window() {
        let mut history = VecDeque::new();
        let start = Instant::now();
        for _ in 0..RATE_LIMIT {
            assert_eq!(admit(&mut history, start), None);
        }
        let later = start + RATE_WINDOW + Duration::from_millis(1);
        assert_eq!(
            admit(&mut history, later),
            None,
            "the window has rolled over"
        );
    }
}
