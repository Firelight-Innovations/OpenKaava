//! The Agents app's Rust half: which agent VMs exist, what sessions they have
//! run, and one session's transcript.
//!
//! Every read follows `docs/cloud-services.md` §5 and §8. The frontend polls
//! `agents/overview` only while it is visible. Each poll lists metadata and
//! downloads only the `status.json` objects whose generation changed. The one
//! write is `agents/start`, which a person's press of a Start button calls.

use crate::apps::CallContext;
use crate::cloud::{self, compute, storage, Cloud, Source, Trouble};
use kaava_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tauri::{AppHandle, Manager};

/// Newest sessions kept per agent. Older ones stay in the bucket.
const SESSIONS_PER_AGENT: usize = 200;

/// The tail of a transcript the app downloads. A long session's early turns
/// are the least likely to be read, and the whole file can run to tens of MB.
const TRANSCRIPT_TAIL: u64 = 4 << 20;

/// Concurrent `status.json` downloads on a cold first poll.
const PARALLEL_READS: usize = 8;

pub fn call(
    app: &AppHandle,
    _context: &CallContext,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let cloud = app.state::<Cloud>();
    let source = Source::from_env();
    match method {
        "agents/overview" => encode(&overview(&cloud, &source)?),
        "agents/transcript" => {
            let agent = segment(params.as_ref(), "agent")?;
            let session = segment(params.as_ref(), "sessionId")?;
            let known = params
                .as_ref()
                .and_then(|p| p.get("knownGeneration"))
                .and_then(Value::as_i64);
            encode(&transcript(&cloud, &source, &agent, &session, known)?)
        }
        "agents/start" => {
            let name = segment(params.as_ref(), "name")?;
            start(&cloud, &source, &name)?;
            Ok(json!({ "started": name }))
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

fn segment(params: Option<&Value>, key: &str) -> Result<String, RpcError> {
    params
        .and_then(|p| p.get(key))
        .and_then(Value::as_str)
        .filter(|s| cloud::is_plain_segment(s))
        .map(str::to_string)
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("`{key}` is missing or not a name")))
}

// --- overview ----------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub source: &'static str,
    pub project: String,
    pub machines: Vec<compute::Machine>,
    pub sessions: Vec<Session>,
    /// A part that failed while the rest answered, such as a denied Compute
    /// list beside a readable bucket.
    pub problems: Vec<Problem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub area: &'static str,
    pub message: String,
    pub trouble: Trouble,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub agent: String,
    pub session_id: String,
    pub status_generation: i64,
    /// When the object was written, from storage metadata. Sorts sessions even
    /// when `status.json` is unreadable.
    pub written: String,
    /// `status.json` as the hook wrote it, or `null` when it would not parse.
    pub status: Value,
    pub transcript: Option<storage::Object>,
}

/// Sign-in failures stop the whole overview: nothing else can succeed, and the
/// app shows the fix instead of two identical errors.
fn is_auth(trouble: &Trouble) -> bool {
    matches!(trouble, Trouble::GcloudMissing | Trouble::SignedOut { .. })
}

pub fn overview(cloud: &Cloud, source: &Source) -> Result<Overview, Trouble> {
    let mut problems = Vec::new();

    let machines = match compute::list(cloud, source, "agent") {
        Ok(m) => m,
        Err(t) if is_auth(&t) => return Err(t),
        Err(t) => {
            problems.push(Problem {
                area: "machines",
                message: t.message(),
                trouble: t,
            });
            Vec::new()
        }
    };

    let sessions = match sessions(cloud, source) {
        Ok(s) => s,
        Err(t) if is_auth(&t) => return Err(t),
        Err(t) => {
            problems.push(Problem {
                area: "sessions",
                message: t.message(),
                trouble: t,
            });
            Vec::new()
        }
    };

    Ok(Overview {
        source: source.kind(),
        project: source.project().to_string(),
        machines,
        sessions,
        problems,
    })
}

fn sessions(cloud: &Cloud, source: &Source) -> Result<Vec<Session>, Trouble> {
    let bucket = cloud::SESSIONS_BUCKET;
    let top = storage::list(cloud, source, bucket, "", true)?;
    let agents: Vec<String> = top
        .prefixes
        .iter()
        .map(|p| p.trim_end_matches('/').to_string())
        // `_workflows/` is reserved for the orchestrator (§6), not an agent.
        .filter(|a| !a.starts_with('_') && cloud::is_plain_segment(a))
        .collect();

    let mut found = Vec::new();
    for agent in &agents {
        let listing = storage::list(cloud, source, bucket, &format!("{agent}/"), false)?;
        found.extend(group(agent, listing.objects));
    }

    // Read what the cache does not already hold at this generation.
    let stale: Vec<usize> = found
        .iter()
        .enumerate()
        .filter(|(_, (_, status, _))| {
            cloud
                .cache
                .get(&key(&status.name), status.generation)
                .is_none()
        })
        .map(|(i, _)| i)
        .collect();
    for chunk in stale.chunks(PARALLEL_READS) {
        let results: Vec<_> = std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|&i| {
                    let object = &found[i].1;
                    scope.spawn(move || storage::read(cloud, source, bucket, object, None))
                })
                .collect();
            handles.into_iter().map(|h| h.join()).collect()
        });
        for (&i, result) in chunk.iter().zip(results) {
            let object = &found[i].1;
            match result {
                Ok(Ok(content)) => {
                    let value = serde_json::from_slice(&content.bytes).unwrap_or(Value::Null);
                    cloud.cache.put(key(&object.name), object.generation, value);
                }
                Ok(Err(t)) if is_auth(&t) => return Err(t),
                // One unreadable status must not hide the rest. It shows as a
                // session with no status and is tried again next poll.
                _ => {}
            }
        }
    }

    Ok(found
        .into_iter()
        .map(|(id, status, transcript)| Session {
            agent: id.0,
            session_id: id.1,
            status_generation: status.generation,
            written: status.updated.clone(),
            status: cloud
                .cache
                .get(&key(&status.name), status.generation)
                .unwrap_or(Value::Null),
            transcript,
        })
        .collect())
}

fn key(object: &str) -> String {
    format!("{}/{object}", cloud::SESSIONS_BUCKET)
}

type Found = ((String, String), storage::Object, Option<storage::Object>);

/// One agent's objects, grouped by session and trimmed to the newest
/// [`SESSIONS_PER_AGENT`] by write time.
fn group(agent: &str, objects: Vec<storage::Object>) -> Vec<Found> {
    let mut by_session: BTreeMap<String, (Option<storage::Object>, Option<storage::Object>)> =
        BTreeMap::new();
    for object in objects {
        let mut parts = object.name.splitn(3, '/');
        let (Some(_), Some(session), Some(file)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if !cloud::is_plain_segment(session) {
            continue;
        }
        let slot = by_session.entry(session.to_string()).or_default();
        match file {
            "status.json" => slot.0 = Some(object),
            "transcript.jsonl" => slot.1 = Some(object),
            _ => {}
        }
    }
    let mut found: Vec<Found> = by_session
        .into_iter()
        .filter_map(|(session, (status, transcript))| {
            status.map(|s| ((agent.to_string(), session), s, transcript))
        })
        .collect();
    found.sort_by(|a, b| b.1.updated.cmp(&a.1.updated));
    found.truncate(SESSIONS_PER_AGENT);
    found
}

// --- transcript --------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    /// `null` when the session has no transcript yet (none before its first Stop).
    pub generation: Option<i64>,
    pub size: u64,
    pub updated: Option<String>,
    /// Same generation as `knownGeneration`, so `text` was not downloaded.
    pub unchanged: bool,
    /// Whole JSONL lines. With `truncated`, the file's last 4 MiB, starting
    /// at the first complete line.
    pub text: String,
    pub truncated: bool,
}

pub fn transcript(
    cloud: &Cloud,
    source: &Source,
    agent: &str,
    session: &str,
    known: Option<i64>,
) -> Result<Transcript, Trouble> {
    let name = format!("{agent}/{session}/transcript.jsonl");
    let listing = storage::list(cloud, source, cloud::SESSIONS_BUCKET, &name, false)?;
    let Some(object) = listing.objects.into_iter().find(|o| o.name == name) else {
        return Ok(Transcript {
            generation: None,
            size: 0,
            updated: None,
            unchanged: known.is_none(),
            text: String::new(),
            truncated: false,
        });
    };
    if known == Some(object.generation) {
        return Ok(Transcript {
            generation: Some(object.generation),
            size: object.size,
            updated: Some(object.updated),
            unchanged: true,
            text: String::new(),
            truncated: false,
        });
    }
    let content = storage::read(
        cloud,
        source,
        cloud::SESSIONS_BUCKET,
        &object,
        Some(TRANSCRIPT_TAIL),
    )?;
    let mut text = String::from_utf8_lossy(&content.bytes).into_owned();
    if content.truncated {
        // The first line is cut mid-way; drop it rather than show half a JSON.
        text = text
            .split_once('\n')
            .map(|(_, rest)| rest.to_string())
            .unwrap_or_default();
    }
    Ok(Transcript {
        generation: Some(content.generation),
        size: object.size,
        updated: Some(object.updated),
        unchanged: false,
        text,
        truncated: content.truncated,
    })
}

// --- start -------------------------------------------------------------------

/// Start a stopped agent VM. Refuses a name that is not an agent machine, so
/// this cannot start the GPU node or anything else in the project.
pub fn start(cloud: &Cloud, source: &Source, name: &str) -> Result<(), RpcError> {
    let machines = compute::list(cloud, source, "agent")?;
    let machine = machines.iter().find(|m| m.name == name).ok_or_else(|| {
        RpcError::new(INVALID_PARAMS, format!("`{name}` is not an agent machine"))
    })?;
    if machine.status != "TERMINATED" {
        return Err(RpcError::new(
            INVALID_PARAMS,
            format!("`{name}` is {}, not stopped", machine.status),
        ));
    }
    compute::start(cloud, source, machine)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// `src-tauri/fixtures/cloud`, resolved at run time rather than with
    /// `env!`, so a target dir shared between worktrees cannot bake in another
    /// checkout's path.
    fn committed_fixture() -> Source {
        let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("run under cargo");
        Source::Fixture {
            root: PathBuf::from(manifest).join("fixtures").join("cloud"),
        }
    }

    #[test]
    fn the_overview_reads_every_agent_and_skips_workflows() {
        let overview = overview(&Cloud::default(), &committed_fixture()).unwrap();
        assert!(overview.problems.is_empty(), "{:?}", overview.problems);
        assert_eq!(overview.source, "fixture");
        assert!(overview
            .machines
            .iter()
            .all(|m| m.role.as_deref() == Some("agent")));
        assert!(overview.sessions.iter().all(|s| !s.agent.starts_with('_')));
        let agents: std::collections::BTreeSet<_> =
            overview.sessions.iter().map(|s| s.agent.as_str()).collect();
        assert!(agents.len() >= 2, "{agents:?}");
    }

    #[test]
    fn every_fixture_session_has_a_parsed_status() {
        let overview = overview(&Cloud::default(), &committed_fixture()).unwrap();
        for s in &overview.sessions {
            assert_eq!(
                s.status["session_id"],
                s.session_id.as_str(),
                "{}",
                s.session_id
            );
        }
    }

    #[test]
    fn a_second_poll_downloads_nothing_new() {
        let cloud = Cloud::default();
        let first = overview(&cloud, &committed_fixture()).unwrap();
        let second = overview(&cloud, &committed_fixture()).unwrap();
        assert_eq!(first.sessions.len(), second.sessions.len());
        for (a, b) in first.sessions.iter().zip(&second.sessions) {
            assert_eq!(a.status, b.status);
        }
    }

    #[test]
    fn a_known_generation_skips_the_download() {
        let cloud = Cloud::default();
        let source = committed_fixture();
        let overview = overview(&cloud, &source).unwrap();
        let with = overview
            .sessions
            .iter()
            .find(|s| s.transcript.is_some())
            .expect("a fixture session with a transcript");
        let full = transcript(&cloud, &source, &with.agent, &with.session_id, None).unwrap();
        assert!(!full.text.is_empty());
        let again = transcript(
            &cloud,
            &source,
            &with.agent,
            &with.session_id,
            full.generation,
        )
        .unwrap();
        assert!(again.unchanged);
        assert!(again.text.is_empty());
    }

    #[test]
    fn a_session_with_no_transcript_answers_empty() {
        let cloud = Cloud::default();
        let source = committed_fixture();
        let overview = overview(&cloud, &source).unwrap();
        let without = overview
            .sessions
            .iter()
            .find(|s| s.transcript.is_none())
            .expect("a fixture session without a transcript");
        let t = transcript(&cloud, &source, &without.agent, &without.session_id, None).unwrap();
        assert_eq!(t.generation, None);
        assert!(t.text.is_empty());
    }

    #[test]
    fn start_refuses_a_machine_that_is_not_an_agent() {
        let err = start(&Cloud::default(), &committed_fixture(), "kaava-gpu").unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
    }

    #[test]
    fn grouping_keeps_the_newest_and_drops_orphans() {
        let obj = |name: &str, updated: &str| storage::Object {
            name: name.into(),
            generation: 1,
            updated: updated.into(),
            size: 1,
        };
        let found = group(
            "a",
            vec![
                obj("a/old/status.json", "2026-01-01T00:00:00Z"),
                obj("a/new/status.json", "2026-02-01T00:00:00Z"),
                obj("a/new/transcript.jsonl", "2026-02-01T00:00:00Z"),
                obj("a/orphan/transcript.jsonl", "2026-03-01T00:00:00Z"),
            ],
        );
        let ids: Vec<_> = found.iter().map(|f| f.0 .1.as_str()).collect();
        assert_eq!(ids, vec!["new", "old"]);
        assert!(found[0].2.is_some());
    }

    #[test]
    fn a_bad_param_is_refused_before_any_call() {
        let bad = json!({ "agent": "../x", "sessionId": "s" });
        assert!(segment(Some(&bad), "agent").is_err());
        assert!(segment(None, "agent").is_err());
    }
}
