//! Talking to Plane CE's own REST API, through the `kaava-api` gateway.
//!
//! `OPENKAAVA-PLANE-DESIGN.md` §3 and §7.1: paths under `/api/v1/`, cursor
//! pagination with `per_page` at most [`MAX_PER_PAGE`], and a 300-requests-
//! per-minute budget per key (§12 V4). The gateway (`services/kaava-api`)
//! holds the Plane token and adds it itself, so this side holds no Plane
//! secret at all: it sends a Google ID token ([`gateway`]) and a path.
//! `apps/projects.rs` exposes [`call`] as `plane/get`, `plane/post` and
//! `plane/patch`.

use super::gateway::{self, Gateway};
use super::{is_plain_segment, Cloud, Result, Source, Trouble};
use serde_json::Value;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Where the gateway forwards to Plane's `/api/v1/`.
const GATEWAY_PREFIX: &str = "v1/plane/api/v1/";

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

/// Held on [`Cloud`]: the call budget, process-wide. The gateway keeps the
/// same budget for the key; this one stops a burst from this app reaching it.
#[derive(Default)]
pub struct PlaneState {
    limiter: RateLimiter,
}

/// A path is safe to append to `/api/v1/` when every segment is a plain
/// name — the same rule [`is_plain_segment`] already enforces for a storage
/// object name, applied here so `plane/get` cannot be turned into a request
/// against an arbitrary host or a `../` escape out of `/api/v1/`. A trailing
/// slash (Plane's own list endpoints all have one) is allowed by treating the
/// empty segment it produces as fine. The gateway checks the same rule again.
pub fn is_safe_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains("..")
        && path
            .split('/')
            .all(|seg| seg.is_empty() || is_plain_segment(seg))
}

/// One call to Plane's REST API. `path` and `query` are the caller's; `path`
/// must already satisfy [`is_safe_path`] (the app method checks it before
/// this is reached, and this checks again rather than trust a second call
/// site to remember to).
pub fn call(
    cloud: &Cloud,
    source: &Source,
    gateway: &Gateway,
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
        Source::Live { .. } => call_live(cloud, gateway, method, path, query, body),
        Source::Fixture { root } => call_fixture(root, method, path),
    }
}

fn call_live(
    cloud: &Cloud,
    gateway: &Gateway,
    method: Method,
    path: &str,
    query: &[(String, String)],
    body: Option<Value>,
) -> Result<Value> {
    // Unconfigured is a state to show, not a call to spend budget on.
    if !gateway.is_configured() {
        return Err(Trouble::GatewayUnconfigured);
    }
    cloud.plane.limiter.wait(std::thread::sleep);
    let verb = match method {
        Method::Get => gateway::Verb::Get,
        Method::Post => gateway::Verb::Post,
        Method::Patch => gateway::Verb::Patch,
    };
    gateway::call(cloud, gateway, verb, &gateway_path(path), query, body).map_err(|trouble| {
        match trouble {
            // The gateway's 404 names its own route; say which Plane path it was.
            Trouble::Missing { .. } => Trouble::Missing {
                what: format!("Plane {path}"),
            },
            other => other,
        }
    })
}

/// The gateway route for one Plane path.
fn gateway_path(path: &str) -> String {
    format!("{GATEWAY_PREFIX}{path}")
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
/// than refusing: a caller waiting a few seconds is a better experience than
/// a caller who has to notice a `Trouble` and retry by hand for something
/// that was never actually denied.
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

    fn no_gateway() -> Gateway {
        Gateway {
            url: String::new(),
            client_id: String::new(),
        }
    }

    #[test]
    fn is_safe_path_accepts_plane_style_paths_and_refuses_traversal() {
        assert!(is_safe_path("workspaces/veistra/projects/"));
        assert!(is_safe_path("workspaces/veistra/projects/abc-123/issues/"));
        for bad in ["", "/workspaces", "workspaces/../secrets", "http://evil"] {
            assert!(!is_safe_path(bad), "{bad:?} must be refused");
        }
    }

    /// Replaces the old PAT-cache test: the fixture tree no longer has a
    /// `secrets/` folder, because this side never holds a Plane token.
    #[test]
    fn a_fixture_answers_without_any_plane_token_or_gateway() {
        let (dir, source) = fixture_root();
        assert!(!dir.path().join("secrets").exists());
        let cloud = Cloud::default();
        let value = call(
            &cloud,
            &source,
            &no_gateway(),
            Method::Get,
            "workspaces/veistra/projects/",
            &[],
            None,
        )
        .unwrap();
        assert_eq!(value["results"], serde_json::json!([]));
    }

    #[test]
    fn a_live_call_without_a_gateway_url_is_unconfigured_before_any_network() {
        let cloud = Cloud::default();
        let source = Source::Live {
            project: "veistra-prod".into(),
        };
        let err = call(
            &cloud,
            &source,
            &no_gateway(),
            Method::Get,
            "workspaces/veistra/projects/",
            &[],
            None,
        )
        .unwrap_err();
        assert_eq!(err, Trouble::GatewayUnconfigured);
    }

    #[test]
    fn an_unsafe_path_is_refused_before_any_fixture_lookup() {
        let (_dir, source) = fixture_root();
        let cloud = Cloud::default();
        let err = call(
            &cloud,
            &source,
            &no_gateway(),
            Method::Get,
            "../escape",
            &[],
            None,
        )
        .unwrap_err();
        assert!(matches!(err, Trouble::Missing { .. }));
    }

    #[test]
    fn a_missing_fixture_file_is_a_fixture_trouble_not_a_panic() {
        let (_dir, source) = fixture_root();
        let cloud = Cloud::default();
        let err = call(
            &cloud,
            &source,
            &no_gateway(),
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

    /// Was `build_url_appends_an_encoded_query_string`. The query is now
    /// encoded by `gateway::Gateway::endpoint`, tested there; what is left
    /// here is the route.
    #[test]
    fn a_plane_path_goes_under_the_gateways_proxy_route() {
        assert_eq!(
            gateway_path("workspaces/veistra/projects/"),
            "v1/plane/api/v1/workspaces/veistra/projects/"
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
