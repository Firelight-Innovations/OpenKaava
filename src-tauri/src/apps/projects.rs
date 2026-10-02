//! The Projects app's Rust half: the project switcher, the wake flow that
//! brings Plane up from a stopped `plane-vm`, and the proxy to Plane's own
//! REST API. `OPENKAAVA-PLANE-DESIGN.md` §11 (Agent B's tasks) is the spec;
//! `docs/handoffs/plane-frontend.md` in Agent A's worktree is what is
//! actually live today.
//!
//! Every read here follows the same rule the Agents app already does
//! (`cloud`'s module doc): no key on disk, a signed-out identity is a state
//! rather than a network error, and nothing starts a VM or opens a tunnel
//! except in reaction to something a person did. Listing projects
//! (`projects/list`) is a plain bucket read and **never** wakes Plane
//! (design §3.1) — it does not touch [`wake`] or [`tunnel`] at all.
//!
//! The REST proxy, the wake flow and the list go through the `kaava-api`
//! gateway ([`gateway`]). The IAP tunnel and the hosts entry remain only for
//! Plane's own web UI in the child webview.
//!
//! **B1.2 (the `prod`/`dev` profile switch) is deferred.** Every method below
//! reads the `prod` prefix only; see the PR description for the follow-up.

use crate::apps::CallContext;
use crate::cloud::gateway::{self, Gateway};
use crate::cloud::{self, compute, plane, storage, tunnel, wake, Cloud, Source, Trouble};
use crate::plane_webview::{self, Bounds};
use crate::settings::{self, keys};
use kaava_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, Manager};

/// design §3: the one profile this PR wires up. B1.2 adds `dev` and a
/// setting to switch between them; until then this is the only prefix
/// `projects/list` ever reads.
const PROFILE: &str = "prod";

/// design §3.3 / §11 B2.4. Named for the fixture source only; live, the
/// gateway knows which VM it wakes.
const PLANE_VM: &str = "plane-vm";
const PLANE_ZONE: &str = "us-central1-a";

/// §11 B2.3: the one-line fix, named rather than left for the frontend to
/// invent — a wrong path here is a support question, not a crash.
const HOSTS_FILE_HINT: &str = r"%SystemRoot%\System32\drivers\etc\hosts";

pub fn call(
    app: &AppHandle,
    _context: &CallContext,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let cloud = app.state::<Cloud>();
    let source = Source::from_env();
    let gateway = gateway_of(app);
    match method {
        "projects/list" => match &source {
            Source::Live { .. } if gateway.is_configured() => {
                encode(&list_via_gateway(&cloud, &gateway)?)
            }
            // No gateway yet: read the bucket with the gcloud login, as before.
            _ => encode(&list(&cloud, &source)?),
        },

        "projects/wake-status" => Ok(wake_status(app)),
        "projects/wake-start" => {
            if matches!(source, Source::Live { .. }) && !gateway.is_configured() {
                return Err(Trouble::GatewayUnconfigured.into());
            }
            wake_start(app, source, gateway);
            Ok(json!({ "started": true }))
        }
        "projects/wake-cancel" => {
            wake_cancel(app);
            Ok(json!({ "cancelled": true }))
        }

        "projects/plane-get" => plane_proxy(
            &cloud,
            &source,
            &gateway,
            plane::Method::Get,
            params.as_ref(),
        ),
        "projects/plane-post" => plane_proxy(
            &cloud,
            &source,
            &gateway,
            plane::Method::Post,
            params.as_ref(),
        ),
        "projects/plane-patch" => plane_proxy(
            &cloud,
            &source,
            &gateway,
            plane::Method::Patch,
            params.as_ref(),
        ),

        "projects/hosts-check" => Ok(hosts_check()),

        "projects/webview-open" => webview_open(app, params.as_ref()),
        "projects/webview-navigate" => webview_navigate(app, params.as_ref()),
        "projects/webview-bounds" => webview_bounds(app, params.as_ref()),
        "projects/webview-close" => {
            plane_webview::close(app).map_err(|e| RpcError::new(INTERNAL_ERROR, e))?;
            Ok(json!({ "closed": true }))
        }

        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no such method: {method}"),
        )),
    }
}

fn encode<T: Serialize>(value: &T) -> Result<Value, RpcError> {
    serde_json::to_value(value).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))
}

/// The gateway's URL and the sign-in's client, as Settings, Cloud has them now.
fn gateway_of(app: &AppHandle) -> Gateway {
    Gateway {
        url: settings::text(app, keys::CLOUD_GATEWAY_URL),
        client_id: settings::text(app, keys::CLOUD_GOOGLE_CLIENT_ID),
    }
}

// --- projects/list -------------------------------------------------------

/// design §3.1, restated field for field. `plane.project_id` and
/// `hindsight_banks` keep the record's own snake_case rather than the
/// camelCase the rest of this app's wire shapes use, because this file is
/// written by `kaava-project` (Python) and read by more than one consumer —
/// renaming it on this side only would mean two spellings of one schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRecord {
    pub schema: u32,
    pub slug: String,
    pub name: String,
    pub game: Option<String>,
    pub plane: PlaneProjectRef,
    /// `null` on a project with no artifact prefix, such as OpenKaava itself.
    #[serde(default)]
    pub artifacts: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub hindsight_banks: Vec<String>,
    pub created: String,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaneProjectRef {
    pub workspace: String,
    pub project_id: String,
    pub identifier: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsList {
    pub source: &'static str,
    pub profile: &'static str,
    pub projects: Vec<ProjectRecord>,
    /// One record that failed to parse must not hide the rest — the same
    /// rule the Agents app's `sessions()` already follows for a bad
    /// `status.json`.
    pub problems: Vec<String>,
}

fn list(cloud: &Cloud, source: &Source) -> Result<ProjectsList, Trouble> {
    let prefix = format!("{PROFILE}/projects/");
    let listing = storage::list(cloud, source, cloud::PROJECTS_BUCKET, &prefix, false)?;

    let mut projects = Vec::new();
    let mut problems = Vec::new();
    for object in listing
        .objects
        .into_iter()
        .filter(|o| o.name.ends_with(".json"))
    {
        match storage::read(cloud, source, cloud::PROJECTS_BUCKET, &object, None) {
            Ok(content) => match serde_json::from_slice::<ProjectRecord>(&content.bytes) {
                Ok(record) => projects.push(record),
                Err(e) => problems.push(format!("{}: {e}", object.name)),
            },
            Err(e) => problems.push(format!("{}: {}", object.name, e.message())),
        }
    }
    projects.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(ProjectsList {
        source: source.kind(),
        profile: PROFILE,
        projects,
        problems,
    })
}

/// The same list, read by the gateway's service account instead of the
/// gcloud login. Still a bucket read that never wakes Plane.
fn list_via_gateway(cloud: &Cloud, gateway: &Gateway) -> Result<ProjectsList, Trouble> {
    Ok(records_to_list(gateway::project_records(
        cloud, gateway, PROFILE,
    )?))
}

/// Parse what the gateway sent. It forwards each record as it found it, so
/// one malformed record becomes a problem here and the rest still list.
fn records_to_list(records: gateway::Records) -> ProjectsList {
    let mut problems = records.problems;
    let mut projects = Vec::new();
    for (index, raw) in records.projects.into_iter().enumerate() {
        let label = raw["slug"]
            .as_str()
            .map_or_else(|| format!("record {}", index + 1), str::to_string);
        match serde_json::from_value::<ProjectRecord>(raw) {
            Ok(record) => projects.push(record),
            Err(e) => problems.push(format!("{label}: {e}")),
        }
    }
    projects.sort_by(|a, b| a.name.cmp(&b.name));
    ProjectsList {
        source: "live",
        profile: PROFILE,
        projects,
        problems,
    }
}

// --- the wake flow (§3.3 / B2.4) ------------------------------------------

/// What `projects/wake-status` answers. Tagged by `phase` so the frontend's
/// "Starting Plane… Ns" state and its Cancel button read straight off one
/// value with no second flag to keep in sync.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum WakeSnapshot {
    #[default]
    Idle,
    // `rename_all` on the enum renames the tags only; each variant's fields
    // need their own, or `elapsed_seconds` reaches the UI in snake_case.
    #[serde(rename_all = "camelCase")]
    Waking {
        elapsed_seconds: f64,
        detail: String,
    },
    #[serde(rename_all = "camelCase")]
    Healthy {
        elapsed_seconds: f64,
    },
    Cancelled,
    TimedOut {
        detail: String,
    },
    Failed {
        detail: String,
        /// The cause, when a call had one: the frontend draws the same
        /// signed-out or gateway state a failed read would.
        #[serde(skip_serializing_if = "Option::is_none")]
        trouble: Option<Trouble>,
    },
}

/// Held in `tauri::State`. One wake at a time: a second `wake-start` while
/// one is already running is a no-op, matching [`tunnel::Tunnel::start`]'s
/// own idempotence for the same reason — two supervising threads racing to
/// write [`WakeManager::snapshot`] is a bug with no correct resolution.
#[derive(Default)]
pub struct WakeManager {
    snapshot: Mutex<WakeSnapshot>,
    cancel: AtomicBool,
    active: Mutex<bool>,
}

fn wake_status(app: &AppHandle) -> Value {
    let manager = app.state::<WakeManager>();
    let snapshot = manager
        .snapshot
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    serde_json::to_value(&snapshot).unwrap_or(Value::Null)
}

fn wake_cancel(app: &AppHandle) {
    app.state::<WakeManager>()
        .cancel
        .store(true, Ordering::SeqCst);
}

/// Start the wake flow on a background thread, unless one is already
/// running. Live, every probe is a gateway call. A fixture source answers
/// from the compute fixtures and is healthy at once, but still runs the same
/// state machine, which is what keeps the UI path identical in both modes.
fn wake_start(app: &AppHandle, source: Source, gateway: Gateway) {
    let manager = app.state::<WakeManager>();
    {
        let mut active = manager.active.lock().unwrap_or_else(|e| e.into_inner());
        if *active {
            return;
        }
        *active = true;
    }
    manager.cancel.store(false, Ordering::SeqCst);
    *manager.snapshot.lock().unwrap_or_else(|e| e.into_inner()) = WakeSnapshot::Waking {
        elapsed_seconds: 0.0,
        detail: "checking plane-vm".to_string(),
    };

    // The REST calls no longer need it, but Plane's web UI in the child
    // webview still does (gcloud's IAP tunnel and the hosts entry).
    if let Source::Live { project } = &source {
        app.state::<tunnel::Tunnel>().start(project.clone());
    }

    let app = app.clone();
    std::thread::spawn(move || run_wake(&app, source, gateway));
}

fn run_wake(app: &AppHandle, source: Source, gateway: Gateway) {
    let cloud = app.state::<Cloud>();
    let live = matches!(source, Source::Live { .. });
    // The last failure's cause, so a failed wake can name it to the UI; the
    // state machine itself only carries strings.
    let cause: Mutex<Option<Trouble>> = Mutex::new(None);
    let keep = |trouble: Trouble| -> String {
        let message = trouble.message();
        *cause.lock().unwrap_or_else(|e| e.into_inner()) = Some(trouble);
        message
    };

    let status_probe = || -> Result<String, String> {
        if live {
            gateway::plane_status(&cloud, &gateway)
                .map(|s| s.vm)
                .map_err(keep)
        } else {
            compute::status(&cloud, &source, "fixture", PLANE_ZONE, PLANE_VM).map_err(keep)
        }
    };
    let start_probe = || -> Result<(), String> {
        if live {
            gateway::plane_wake(&cloud, &gateway)
                .map(|_| ())
                .map_err(keep)
        } else {
            compute::start_named(&cloud, &source, "fixture", PLANE_ZONE, PLANE_VM).map_err(keep)
        }
    };
    // design §3.3 step 3: the gateway checks Plane's two health paths from
    // inside the VPC. "Not yet" is an `Err` that `wake::wake` keeps polling.
    let health_probe = || -> Result<(), String> {
        if !live {
            return Ok(());
        }
        match gateway::plane_status(&cloud, &gateway) {
            Ok(status) if status.healthy => Ok(()),
            Ok(status) => Err(status.detail),
            Err(trouble) => Err(keep(trouble)),
        }
    };
    let probes = wake::Probes {
        status: &status_probe,
        start: &start_probe,
        health: &health_probe,
    };

    let clock_start = Instant::now();
    let now = move || clock_start.elapsed().as_secs_f64();
    let clock = wake::Clock {
        now: &now,
        sleep: &std::thread::sleep,
    };

    let manager = app.state::<WakeManager>();
    let on_progress = |progress: wake::Progress| {
        let elapsed_seconds = clock_start.elapsed().as_secs_f64();
        let detail = match progress {
            wake::Progress::Status(status) => format!("plane-vm is {status}"),
            wake::Progress::Starting => "starting plane-vm".to_string(),
            wake::Progress::WaitingHealthy(detail) => {
                format!("waiting for Plane to answer ({detail})")
            }
        };
        *manager.snapshot.lock().unwrap_or_else(|e| e.into_inner()) = WakeSnapshot::Waking {
            elapsed_seconds,
            detail,
        };
    };
    let cancel_check = || app.state::<WakeManager>().cancel.load(Ordering::SeqCst);

    let result = wake::wake(&probes, &clock, on_progress, &cancel_check);
    let trouble = cause.lock().unwrap_or_else(|e| e.into_inner()).take();
    let outcome = outcome(result, trouble);

    let manager = app.state::<WakeManager>();
    *manager.snapshot.lock().unwrap_or_else(|e| e.into_inner()) = outcome;
    *manager.active.lock().unwrap_or_else(|e| e.into_inner()) = false;
}

/// The snapshot a finished wake leaves. `trouble` is the last probe failure's
/// cause, attached only to `Failed`, which is the one outcome a probe error
/// ends in.
fn outcome(result: Result<f64, wake::WakeError>, trouble: Option<Trouble>) -> WakeSnapshot {
    match result {
        Ok(elapsed_seconds) => WakeSnapshot::Healthy { elapsed_seconds },
        Err(wake::WakeError::Cancelled) => WakeSnapshot::Cancelled,
        Err(wake::WakeError::NotRunning { last_status }) => WakeSnapshot::TimedOut {
            detail: format!("plane-vm stayed {last_status}"),
        },
        Err(wake::WakeError::Unhealthy { detail }) => WakeSnapshot::TimedOut { detail },
        Err(wake::WakeError::Probe(detail)) => WakeSnapshot::Failed { detail, trouble },
    }
}

// --- Plane REST proxy (§7.1 / B2.1) ---------------------------------------

/// `plane/get|post|patch`. No tunnel: the gateway reaches Plane, so these
/// work wherever the gateway does. A stopped Plane answers `PlaneAsleep`
/// rather than being woken here; waking is the button's job.
fn plane_proxy(
    cloud: &Cloud,
    source: &Source,
    gateway: &Gateway,
    method: plane::Method,
    params: Option<&Value>,
) -> Result<Value, RpcError> {
    let path = params
        .and_then(|p| p.get("path"))
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "`path` is required"))?;
    if !plane::is_safe_path(path) {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("`{path}` is not a path this app may ask Plane for"),
        ));
    }

    let mut query = Vec::new();
    if let Some(object) = params
        .and_then(|p| p.get("query"))
        .and_then(Value::as_object)
    {
        for (key, value) in object {
            let text = match value {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            let text = if key == "per_page" {
                text.parse::<u32>()
                    .map(|n| plane::clamp_per_page(n).to_string())
                    .unwrap_or(text)
            } else {
                text
            };
            query.push((key.clone(), text));
        }
    }

    let body = params.and_then(|p| p.get("body")).cloned();
    Ok(plane::call(
        cloud, source, gateway, method, path, &query, body,
    )?)
}

// --- the child webview (§11 B1.4/B1.5) ------------------------------------

fn typed_param<T: serde::de::DeserializeOwned>(
    params: Option<&Value>,
    field: &str,
) -> Result<T, RpcError> {
    let raw = params
        .and_then(|p| p.get(field))
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("`{field}` is required")))?;
    serde_json::from_value(raw.clone())
        .map_err(|e| RpcError::new(INVALID_PARAMS, format!("`{field}` is malformed: {e}")))
}

fn string_param(params: Option<&Value>, field: &str) -> Result<String, RpcError> {
    params
        .and_then(|p| p.get(field))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("`{field}` is required")))
}

fn parse_plane_url(raw: &str) -> Result<url::Url, RpcError> {
    let url: url::Url = raw
        .parse()
        .map_err(|e| RpcError::new(INVALID_PARAMS, format!("`url` is not a valid URL: {e}")))?;
    if !plane_webview::is_plane_url(&url) {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("`{raw}` is not a {} URL", plane_webview::PLANE_HOST),
        ));
    }
    Ok(url)
}

fn webview_open(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    let bounds = typed_param::<Bounds>(params, "bounds")?;
    let url = parse_plane_url(&string_param(params, "url")?)?;
    // The window the page is open in. Absent from a caller that predates popped-out windows,
    // which meant `main`.
    let window = params
        .and_then(|p| p.get("window"))
        .and_then(Value::as_str)
        .unwrap_or(plane_webview::MAIN_WINDOW);
    plane_webview::open(app, window, bounds, url).map_err(|e| RpcError::new(INTERNAL_ERROR, e))?;
    Ok(json!({ "opened": true }))
}

fn webview_navigate(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    let url = parse_plane_url(&string_param(params, "url")?)?;
    plane_webview::navigate(app, url).map_err(|e| RpcError::new(INTERNAL_ERROR, e))?;
    Ok(json!({ "navigated": true }))
}

fn webview_bounds(app: &AppHandle, params: Option<&Value>) -> Result<Value, RpcError> {
    let bounds = typed_param::<Bounds>(params, "bounds")?;
    plane_webview::set_bounds(app, bounds).map_err(|e| RpcError::new(INTERNAL_ERROR, e))?;
    Ok(json!({ "moved": true }))
}

// --- hosts file check (§11 B2.3, partial) ---------------------------------

fn hosts_check() -> Value {
    let resolved = std::net::ToSocketAddrs::to_socket_addrs(&(plane_webview::PLANE_HOST, 0u16))
        .ok()
        .and_then(|mut addrs| addrs.next())
        .map(|addr| addr.ip());
    let ok = matches!(resolved, Some(std::net::IpAddr::V4(v4)) if v4.is_loopback());
    json!({
        "ok": ok,
        "resolved": resolved.map(|ip| ip.to_string()),
        "fix": if ok {
            None
        } else {
            Some(format!(
                "Add \"127.0.0.1 {}\" to {HOSTS_FILE_HINT} (as an administrator, once).",
                plane_webview::PLANE_HOST
            ))
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// `src-tauri/fixtures/cloud`, resolved at run time — see `apps::agents`'s
    /// own test helper for why `env!` would bake in the wrong worktree's path
    /// under a shared `CARGO_TARGET_DIR`.
    fn committed_fixture() -> Source {
        let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("run under cargo");
        Source::Fixture {
            root: PathBuf::from(manifest).join("fixtures").join("cloud"),
        }
    }

    fn no_gateway() -> Gateway {
        Gateway {
            url: String::new(),
            client_id: String::new(),
        }
    }

    #[test]
    fn records_from_the_gateway_list_sorted_and_a_bad_one_becomes_a_problem() {
        let record = |slug: &str, name: &str| {
            json!({
                "schema": 1, "slug": slug, "name": name, "game": null,
                "plane": { "workspace": "veistra", "project_id": "p", "identifier": "X" },
                "created": "2026-09-01T00:00:00Z",
            })
        };
        let list = records_to_list(gateway::Records {
            projects: vec![
                record("torn", "Torn Apart"),
                json!({ "slug": "broken", "name": 7 }),
                record("anomaly", "Anomaly"),
            ],
            problems: vec!["prod/projects/x.json: unreadable".into()],
        });
        assert_eq!(list.source, "live");
        let names: Vec<&str> = list.projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["Anomaly", "Torn Apart"]);
        assert_eq!(list.problems.len(), 2);
        assert!(list.problems[1].starts_with("broken: "));
    }

    #[test]
    fn a_failed_wake_carries_its_cause_for_the_ui() {
        let snapshot = outcome(
            Err(wake::WakeError::Probe("signed out".into())),
            Some(Trouble::SignInNeeded {
                detail: "lapsed".into(),
            }),
        );
        assert_eq!(
            serde_json::to_value(&snapshot).unwrap(),
            json!({
                "phase": "failed",
                "detail": "signed out",
                "trouble": { "kind": "signInNeeded", "detail": "lapsed" },
            })
        );
        let unexplained = outcome(Err(wake::WakeError::Probe("x".into())), None);
        assert!(serde_json::to_value(&unexplained)
            .unwrap()
            .get("trouble")
            .is_none());
    }

    #[test]
    fn a_timeout_does_not_borrow_a_cause_from_an_earlier_poll() {
        let snapshot = outcome(
            Err(wake::WakeError::Unhealthy {
                detail: "502".into(),
            }),
            Some(Trouble::GatewayUnreachable {
                detail: "blip".into(),
            }),
        );
        assert!(matches!(snapshot, WakeSnapshot::TimedOut { .. }));
    }

    #[test]
    fn a_live_proxy_call_without_a_gateway_is_the_unconfigured_state() {
        let cloud = Cloud::default();
        let source = Source::Live {
            project: "veistra-prod".into(),
        };
        let params = json!({ "path": "workspaces/veistra/projects/" });
        let err = plane_proxy(
            &cloud,
            &source,
            &no_gateway(),
            plane::Method::Get,
            Some(&params),
        )
        .unwrap_err();
        assert_eq!(err.data.unwrap()["kind"], "gatewayUnconfigured");
    }

    #[test]
    fn the_committed_fixture_lists_every_well_formed_project_sorted_by_name() {
        let list = list(&Cloud::default(), &committed_fixture()).unwrap();
        assert_eq!(list.source, "fixture");
        let names: Vec<&str> = list.projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["Anomaly", "OpenKaava", "Sandbox", "Torn Apart"]);
        assert_eq!(list.problems.len(), 1, "the one malformed record");
        assert!(list.problems[0].contains("broken.json"));
    }

    #[test]
    fn an_archived_project_still_lists_and_says_so() {
        let list = list(&Cloud::default(), &committed_fixture()).unwrap();
        let sandbox = list.projects.iter().find(|p| p.slug == "sandbox").unwrap();
        assert!(sandbox.archived);
    }

    #[test]
    fn an_empty_bucket_is_an_empty_list_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(
            dir.path()
                .join(cloud::PROJECTS_BUCKET)
                .join(PROFILE)
                .join("projects"),
        )
        .unwrap();
        let source = Source::Fixture {
            root: dir.path().to_path_buf(),
        };
        let list = list(&Cloud::default(), &source).unwrap();
        assert!(list.projects.is_empty());
        assert!(list.problems.is_empty());
    }

    #[test]
    fn listing_never_touches_the_wake_flow_or_the_tunnel() {
        // No `WakeManager` or `Tunnel` is constructed anywhere in `list` or
        // its call graph — this test is the doc comment's claim made
        // mechanical: if `list` ever gained a call into either, the type it
        // would need is not reachable from this function's signature at all,
        // so the claim is enforced by `list`'s own argument list rather than
        // by inspection here.
        let _: fn(&Cloud, &Source) -> Result<ProjectsList, Trouble> = list;
    }

    #[test]
    fn plane_proxy_refuses_an_unsafe_path_before_building_a_request() {
        let cloud = Cloud::default();
        let source = committed_fixture();
        let params = json!({ "path": "../escape" });
        let err = plane_proxy(
            &cloud,
            &source,
            &no_gateway(),
            plane::Method::Get,
            Some(&params),
        )
        .unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
    }

    #[test]
    fn plane_proxy_clamps_per_page_before_it_ever_reaches_plane() {
        let cloud = Cloud::default();
        let source = committed_fixture();
        let params = json!({
            "path": "workspaces/veistra/projects/",
            "query": { "per_page": 5000 },
        });
        // The fixture answers regardless of the query string (see
        // `plane::call_fixture`'s doc), so a successful call here shows the
        // clamp ran without erroring rather than what value it produced;
        // `plane::tests::per_page_is_never_widened_past_the_cap` covers the
        // clamp itself.
        let value = plane_proxy(
            &cloud,
            &source,
            &no_gateway(),
            plane::Method::Get,
            Some(&params),
        )
        .unwrap();
        assert!(value["results"].is_array());
    }

    #[test]
    fn hosts_check_answers_a_boolean_and_a_fix_string_together() {
        let value = hosts_check();
        assert!(value["ok"].is_boolean());
        if value["ok"] == json!(false) {
            assert!(value["fix"]
                .as_str()
                .unwrap()
                .contains(plane_webview::PLANE_HOST));
        }
    }

    #[test]
    fn a_default_wake_manager_reports_idle() {
        let manager = WakeManager::default();
        let snapshot = manager.snapshot.lock().unwrap();
        assert!(matches!(*snapshot, WakeSnapshot::Idle));
    }

    #[test]
    fn a_wake_snapshot_names_its_fields_in_camel_case() {
        let waking = WakeSnapshot::Waking {
            elapsed_seconds: 4.5,
            detail: "starting".into(),
        };
        assert_eq!(
            serde_json::to_value(&waking).unwrap(),
            json!({ "phase": "waking", "elapsedSeconds": 4.5, "detail": "starting" })
        );
        let healthy = WakeSnapshot::Healthy {
            elapsed_seconds: 30.0,
        };
        assert_eq!(
            serde_json::to_value(&healthy).unwrap(),
            json!({ "phase": "healthy", "elapsedSeconds": 30.0 })
        );
    }

    #[test]
    fn a_project_with_no_artifacts_prefix_still_lists() {
        let list = list(&Cloud::default(), &committed_fixture()).unwrap();
        let kaava = list
            .projects
            .iter()
            .find(|p| p.slug == "openkaava")
            .unwrap();
        assert_eq!(kaava.artifacts, None);
    }
}
