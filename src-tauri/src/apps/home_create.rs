//! `home/create-project` — the Tauri half of the New Project page's Create
//! column (board 14, `docs/KAAVA-UX-REWORK.md` §7). `project::create::run` is
//! the actual step-runner and is pure; everything here is the plumbing that
//! wires its [`project::create::Ops`] to the real filesystem and `git`, and
//! exposes it as two RPC methods the same way `apps::projects`' wake flow
//! exposes `projects/wake-start` and `projects/wake-status`:
//!
//! - `home/create-project` starts a run on a background thread and returns at
//!   once — a clone alone can run long enough that blocking the call would
//!   read as a hung app.
//! - `home/create-project-status` reads whatever the run has gotten to. The
//!   frontend polls this the same way `apps/projects/ui`'s `App.tsx` polls
//!   `projects/wake-status`.
//!
//! One run at a time, guarded by [`CreateManager::active`] exactly as
//! `WakeManager` guards a wake — a second `home/create-project` while one is
//! already going is refused rather than queued or raced.

use crate::apps::CallContext;
use crate::git;
use crate::project::{self, create};
use kaava_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// Held in `tauri::State`, registered in `lib.rs` beside `apps::projects::
/// WakeManager`. `snapshot` is `None` only before the first `home/create-
/// project` this process has ever run; `home/create-project-status` answers
/// an empty, not-running plan for that case rather than an error, since
/// "nothing has been asked for yet" is not a failure.
#[derive(Default)]
pub(crate) struct CreateManager {
    snapshot: Mutex<Option<create::Snapshot>>,
    active: Mutex<bool>,
}

/// Start a run, unless one is already going. Returns at once — poll
/// `home/create-project-status` for what happens next.
pub fn start(app: &AppHandle, context: &CallContext, params: Option<Value>) -> Result<Value, RpcError> {
    let cluster_id = context.require_cluster()?.to_string();
    let request = parse_request(params.as_ref())?;

    let manager = app.state::<CreateManager>();
    {
        let mut active = manager.active.lock().unwrap_or_else(|e| e.into_inner());
        if *active {
            return Err(RpcError::new(
                INTERNAL_ERROR,
                "a project is already being created in this window — \
                 wait for it to finish, or check home/create-project-status",
            ));
        }
        *active = true;
    }

    // Seeded before the thread's first emit lands, so a status poll that
    // arrives in the gap between this call returning and the thread's first
    // step settling sees "every step pending" rather than nothing at all.
    let pending_steps: Vec<create::StepState> = create::STEP_ORDER
        .iter()
        .map(|&id| create::StepState {
            id,
            status: create::StepStatus::Pending,
        })
        .collect();
    *manager.snapshot.lock().unwrap_or_else(|e| e.into_inner()) = Some(create::Snapshot {
        steps: pending_steps,
        running: true,
        opened_path: None,
        failed_step: None,
    });

    let app = app.clone();
    std::thread::spawn(move || run_create(&app, &cluster_id, &request));

    Ok(json!({ "started": true }))
}

/// What the run has gotten to, as `home/create-project-status` answers it.
pub fn status(app: &AppHandle) -> Result<Value, RpcError> {
    let manager = app.state::<CreateManager>();
    let snapshot = manager
        .snapshot
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let wire = snapshot.as_ref().map(to_wire).unwrap_or_default();
    serde_json::to_value(wire).map_err(|e| RpcError::new(INTERNAL_ERROR, e.to_string()))
}

/// The real [`create::Ops`], and the call into [`create::run`] itself. Split
/// from [`start`] for the reason `apps::projects::run_wake` is split from
/// `wake_start`: everything below runs on the background thread, and
/// `app.state::<CreateManager>()` is asked for fresh here rather than
/// captured, which is what lets `start` return before this has even begun.
fn run_create(app: &AppHandle, cluster_id: &str, request: &create::Request) {
    let land_code = |source: &create::CodeSource, kind: create::Kind| land(source, kind);
    let unland_code = |result: &create::CodeResult| unland(result);
    let is_git_repo = |path: &Path| git::repo_root(path).is_some();
    let create_worktree = |path: &Path| {
        git::add_worktree(path, &design_worktree_path(path), "design").map_err(|e| e.to_string())
    };
    let remove_worktree = |path: &Path| {
        git::remove_worktree(path, &design_worktree_path(path), true).map_err(|e| e.to_string())
    };
    let open_project = |path: &Path| {
        project::open(app, path, cluster_id)
            .map(|_| ())
            .map_err(|e| e.to_string())
    };

    let ops = create::Ops {
        land_code: Box::new(land_code),
        unland_code: Box::new(unland_code),
        is_git_repo: Box::new(is_git_repo),
        create_worktree: Box::new(create_worktree),
        remove_worktree: Box::new(remove_worktree),
        open_project: Box::new(open_project),
    };

    let manager = app.state::<CreateManager>();
    let final_snapshot = create::run(request, &ops, |snapshot| {
        *manager.snapshot.lock().unwrap_or_else(|e| e.into_inner()) = Some(snapshot.clone());
    });

    *manager.snapshot.lock().unwrap_or_else(|e| e.into_inner()) = Some(final_snapshot);
    *manager.active.lock().unwrap_or_else(|e| e.into_inner()) = false;
}

fn design_worktree_path(repo: &Path) -> PathBuf {
    repo.join("wt").join("design")
}

/// [`create::Ops::land_code`]'s real body: clone or link the code, then write
/// a manifest if the folder does not already have one — §7 step 2, "Clone it
/// and write kaava.toml".
///
/// "Open existing" is the one kind this refuses to write a manifest for: §7
/// says it "only links" a project, so a folder with no manifest is a
/// validation failure here rather than something this step fixes on the
/// user's behalf.
fn land(source: &create::CodeSource, kind: create::Kind) -> Result<create::CodeResult, String> {
    let (path, created_dir) = match source {
        create::CodeSource::ExistingRepo { url, clone_to } => {
            if clone_to.exists() {
                return Err(format!(
                    "{} already exists — choose an empty clone location",
                    clone_to.display()
                ));
            }
            git_clone(url, clone_to)?;
            (clone_to.clone(), true)
        }
        create::CodeSource::LocalFolder { path } => {
            if path.is_dir() {
                (path.clone(), false)
            } else if kind == create::Kind::OpenExisting {
                return Err(format!("{} does not exist", path.display()));
            } else {
                std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
                (path.clone(), true)
            }
        }
        create::CodeSource::NewGithubRepo => {
            unreachable!("project::create::run never lands a NewGithubRepo — step 1 is not wired")
        }
    };

    if kind == create::Kind::OpenExisting {
        if !project::has_manifest(&path) {
            return Err(format!(
                "{} has no Kaava project file yet — Open existing only links a project that already has one",
                path.display()
            ));
        }
        return Ok(create::CodeResult {
            path,
            created_dir,
            wrote_manifest: false,
        });
    }

    let wrote_manifest = project::ensure_manifest(&path).map_err(|e| e.to_string())?;
    Ok(create::CodeResult {
        path,
        created_dir,
        wrote_manifest,
    })
}

/// [`create::Ops::unland_code`]'s real body, deferring the "delete the whole
/// folder or just the manifest" choice to [`create::CodeResult`] exactly as
/// its own doc comment promises: a folder this run created outright is
/// removed wholesale, one this run only linked has just its manifest undone,
/// and one that had neither (a re-used, already-initialized folder) is left
/// untouched.
fn unland(result: &create::CodeResult) -> Result<(), String> {
    if result.created_dir {
        std::fs::remove_dir_all(&result.path).map_err(|e| e.to_string())
    } else if result.wrote_manifest {
        project::remove_manifest(&result.path).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// A plain, blocking `git clone <url> <dest>`.
///
/// Deliberately not in `git.rs` — that module's doc reserves clone for the
/// pty machinery (byte-level progress, auth prompts, a partial-checkout
/// recovery path) that `home/clone-project`'s eventual real implementation
/// will use. This runs on the background thread `start` already spawns, so
/// it costs the UI nothing but that byte-level progress: board 14 only asks
/// for this step to go Running -> Done, which a blocking call here gives it
/// just as well. Replace this with a call into the pty-backed clone once one
/// exists; `create::Ops::land_code`'s contract does not change either way.
fn git_clone(url: &str, dest: &Path) -> Result<(), String> {
    let parent = dest
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", dest.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let name = dest
        .file_name()
        .ok_or_else(|| format!("{} has no name", dest.display()))?;

    let mut command = std::process::Command::new("git");
    command.current_dir(parent).arg("clone").arg(url).arg(name);
    // Matches `git.rs`'s `run_git`: without this every clone flashes a
    // console window on Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command
        .output()
        .map_err(|e| format!("git clone: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git clone: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

// --- request parsing -------------------------------------------------------

fn parse_request(params: Option<&Value>) -> Result<create::Request, RpcError> {
    let kind = match string_field(params, "kind")?.as_str() {
        "game" => create::Kind::Game,
        "tool" => create::Kind::Tool,
        "openExisting" => create::Kind::OpenExisting,
        other => {
            return Err(RpcError::new(
                INVALID_PARAMS,
                format!("`kind` must be \"game\", \"tool\" or \"openExisting\", got {other:?}"),
            ))
        }
    };

    let code = params
        .and_then(|p| p.get("code"))
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, "`code` is required"))?;
    let source = string_field(Some(code), "source")?;
    let code = match source.as_str() {
        "newGithubRepo" => create::CodeSource::NewGithubRepo,
        "existingRepo" => create::CodeSource::ExistingRepo {
            url: string_field(Some(code), "url")?,
            clone_to: PathBuf::from(string_field(Some(code), "cloneTo")?),
        },
        "localFolder" => create::CodeSource::LocalFolder {
            path: PathBuf::from(string_field(Some(code), "path")?),
        },
        other => {
            return Err(RpcError::new(
                INVALID_PARAMS,
                format!(
                    "`code.source` must be \"newGithubRepo\", \"existingRepo\" or \"localFolder\", got {other:?}"
                ),
            ))
        }
    };

    Ok(create::Request { kind, code })
}

fn string_field(params: Option<&Value>, field: &str) -> Result<String, RpcError> {
    params
        .and_then(|p| p.get(field))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("`{field}` is required")))
}

// --- the wire shape ----------------------------------------------------------

/// `create::Snapshot`, translated to the tagged JSON the Create column reads.
/// `project::create` stays free of `serde` on purpose — see its module doc —
/// so this mapping is the one place that decides the wire spelling, the same
/// separation `apps::projects::WakeSnapshot` draws from `cloud::wake::
/// Progress`.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireSnapshot {
    steps: Vec<WireStep>,
    running: bool,
    opened_path: Option<String>,
    failed_step: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireStep {
    id: &'static str,
    number: u8,
    status: &'static str,
    detail: Option<String>,
}

fn to_wire(snapshot: &create::Snapshot) -> WireSnapshot {
    WireSnapshot {
        steps: snapshot.steps.iter().map(wire_step).collect(),
        running: snapshot.running,
        opened_path: snapshot.opened_path.clone(),
        failed_step: snapshot.failed_step.map(step_id_str),
    }
}

fn wire_step(step: &create::StepState) -> WireStep {
    let (status, detail) = match &step.status {
        create::StepStatus::Pending => ("pending", None),
        create::StepStatus::Running => ("running", None),
        create::StepStatus::Done(detail) => ("done", Some(detail.clone())),
        create::StepStatus::Skipped(detail) => ("skipped", Some(detail.clone())),
        create::StepStatus::Failed(detail) => ("failed", Some(detail.clone())),
        create::StepStatus::RolledBack => ("rolledBack", None),
    };
    WireStep {
        id: step_id_str(step.id),
        number: step_number(step.id),
        status,
        detail,
    }
}

/// The board's own step numbers (§7's "1 Create the GitHub repo…" through
/// "8 Open the project"), and [`create::STEP_ORDER`]'s position — one to one,
/// checked by `every_step_id_has_a_wire_name_and_a_number` below.
fn step_number(id: create::StepId) -> u8 {
    create::STEP_ORDER
        .iter()
        .position(|&candidate| candidate == id)
        .map(|index| index as u8 + 1)
        .unwrap_or(0)
}

fn step_id_str(id: create::StepId) -> &'static str {
    match id {
        create::StepId::GithubRepo => "githubRepo",
        create::StepId::CloneOrLink => "cloneOrLink",
        create::StepId::Plane => "plane",
        create::StepId::Registry => "registry",
        create::StepId::Hindsight => "hindsight",
        create::StepId::ProjectRecord => "projectRecord",
        create::StepId::DesignWorktree => "designWorktree",
        create::StepId::OpenProject => "openProject",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_step_id_has_a_wire_name_and_a_number() {
        for (index, &id) in create::STEP_ORDER.iter().enumerate() {
            assert_eq!(step_number(id), index as u8 + 1);
            assert!(!step_id_str(id).is_empty());
        }
    }

    #[test]
    fn parse_request_reads_a_local_folder_source() {
        let params = json!({
            "kind": "tool",
            "code": { "source": "localFolder", "path": "C:/code/torn-apart" },
        });
        let request = parse_request(Some(&params)).unwrap();
        assert_eq!(request.kind, create::Kind::Tool);
        assert!(matches!(request.code, create::CodeSource::LocalFolder { .. }));
    }

    #[test]
    fn parse_request_rejects_an_unknown_kind() {
        let params = json!({
            "kind": "sandwich",
            "code": { "source": "localFolder", "path": "C:/code/x" },
        });
        let err = parse_request(Some(&params)).unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
    }

    #[test]
    fn parse_request_rejects_a_missing_code_field() {
        let params = json!({
            "kind": "game",
            "code": { "source": "existingRepo", "url": "https://example.com/x.git" },
        });
        let err = parse_request(Some(&params)).unwrap_err();
        assert_eq!(err.code, INVALID_PARAMS);
    }

    /// The one rollback path `project::create`'s own tests cannot cover,
    /// because it needs a real filesystem: an "Open existing" folder that
    /// turns out to have no manifest fails `land` cleanly rather than
    /// writing one on the user's behalf.
    #[test]
    fn open_existing_refuses_a_folder_with_no_manifest() {
        let dir = std::env::temp_dir().join(format!("kaava-create-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let source = create::CodeSource::LocalFolder { path: dir.clone() };
        let result = land(&source, create::Kind::OpenExisting);

        let _ = std::fs::remove_dir_all(&dir);
        assert!(result.is_err());
    }

    /// The same folder, requested as a Game instead, writes the manifest
    /// rather than refusing — the one behaviour difference `land` draws
    /// between "Open existing" and every other kind.
    #[test]
    fn a_game_writes_a_manifest_into_an_existing_empty_folder() {
        let dir = std::env::temp_dir().join(format!("kaava-create-test-game-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let source = create::CodeSource::LocalFolder { path: dir.clone() };
        let result = land(&source, create::Kind::Game);

        let ok = result.is_ok();
        let wrote_manifest = result.map(|r| r.wrote_manifest).unwrap_or(false);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(ok);
        assert!(wrote_manifest);
    }
}
