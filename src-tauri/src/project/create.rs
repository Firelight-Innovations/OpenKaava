//! The `kaava-project create` step-runner — pure state machine, no filesystem,
//! no `git`, no `AppHandle`.
//!
//! Board 14 (`docs/design/KAAVA-UX-SPEC.md` §"Board 14") and
//! `docs/KAAVA-UX-REWORK.md` §7 fix eight steps, in order, and this build does
//! not talk to GitHub, Plane or GCS at all (see the UX rework brief). So five
//! of the eight — the GitHub repo, Plane, the registry prefix, the Hindsight
//! banks, and the project record — always report [`StepStatus::Skipped`] with
//! a "not wired yet" detail, and [`run`] never fails the whole plan for one of
//! them. Only three steps do real work: landing the code on disk, cutting
//! `wt/design`, and opening the project.
//!
//! [`run`] is deliberately ignorant of *how* those three happen — every side
//! effect is a closure on [`Ops`], the same shape `cloud::wake` uses for the
//! same reason: the sequencing and rollback logic below is exercised in the
//! tests at the bottom with no `git` binary, no network and no `AppHandle` in
//! sight. `apps::home_create` wires the real closures and is what
//! `home/create-project` actually calls.

use std::path::{Path, PathBuf};

/// §7 "1 · WHAT IT IS".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Game,
    Tool,
    OpenExisting,
}

/// §7 "3 · CODE" — how the project's files land on disk.
#[derive(Debug, Clone)]
pub enum CodeSource {
    /// Step 1 (the GitHub repo) has to exist before there is anything to
    /// clone, and step 1 is not wired — so `run` never passes this to
    /// [`Ops::land_code`] at all; it skips [`StepId::CloneOrLink`] with a
    /// message that says why.
    NewGithubRepo,
    /// `git clone <url> <clone_to>`. This never calls GitHub's API — a plain
    /// clone needs only `git` and whatever credential helper is already on
    /// the machine, which is why it is safe to run today.
    ExistingRepo { url: String, clone_to: PathBuf },
    /// A folder already on disk. Created if it does not exist yet (a fresh
    /// local project with no remote), reused if it does.
    LocalFolder { path: PathBuf },
}

/// The eight steps from §7, fixed order, fixed identity. [`STEP_ORDER`] is
/// what a fresh [`Snapshot`] lists and what the UI numbers 1-8.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StepId {
    GithubRepo,
    CloneOrLink,
    Plane,
    Registry,
    Hindsight,
    ProjectRecord,
    DesignWorktree,
    OpenProject,
}

pub const STEP_ORDER: [StepId; 8] = [
    StepId::GithubRepo,
    StepId::CloneOrLink,
    StepId::Plane,
    StepId::Registry,
    StepId::Hindsight,
    StepId::ProjectRecord,
    StepId::DesignWorktree,
    StepId::OpenProject,
];

/// One step's state, exactly the shape the Create column draws: pending,
/// running, done, failed, or rolled back — see §7's own failure paragraph and
/// the common brief's "state (pending, running, done, failed, rolled back)".
#[derive(Debug, Clone, PartialEq)]
pub enum StepStatus {
    Pending,
    Running,
    /// A detail line — a path, or a fixed id like `TORN`. Mono in the UI for
    /// every step but 8, per the spec's `st()` helper note.
    Done(String),
    /// Not attempted, because the backend for it is not wired yet or because
    /// a step it depends on was skipped for the same reason. Not a failure:
    /// `run` carries on past a skipped step rather than stopping the plan.
    Skipped(String),
    Failed(String),
    /// Undone because a later step failed. Only ever follows a `Done`  — a
    /// `Skipped` step made nothing, so there is nothing to roll back.
    RolledBack,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepState {
    pub id: StepId,
    pub status: StepStatus,
}

/// What `home/create-project-status` hands the frontend, and what [`run`]
/// reports through `on_progress` after every step settles.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub steps: Vec<StepState>,
    pub running: bool,
    /// Set once [`StepId::OpenProject`] has actually opened the project —
    /// `None` for every snapshot before that, including one where every
    /// earlier step succeeded. This is the one field a caller should read to
    /// decide "did Create finish", not `running`'s falseness alone, since a
    /// failed run also ends with `running: false`.
    pub opened_path: Option<String>,
    /// The step that ended the run early, if any.
    pub failed_step: Option<StepId>,
}

impl Snapshot {
    fn pending() -> Self {
        Snapshot {
            steps: STEP_ORDER
                .iter()
                .map(|&id| StepState {
                    id,
                    status: StepStatus::Pending,
                })
                .collect(),
            running: true,
            opened_path: None,
            failed_step: None,
        }
    }
}

/// One `home/create-project` request, already validated by the frontend —
/// `run` does not re-derive the slug or re-check the Plane ID's shape, it
/// only decides what each step does with what it is given.
#[derive(Debug, Clone)]
pub struct Request {
    pub kind: Kind,
    pub code: CodeSource,
}

/// The message every not-wired step reports. One constant so the five of them
/// read identically rather than five near-miss phrasings.
const NOT_WIRED: &str = "Not wired yet in this build.";

/// What [`land_code`](Ops::land_code) actually did, so rollback and the
/// worktree step know what is safe to touch.
#[derive(Debug, Clone)]
pub struct CodeResult {
    pub path: PathBuf,
    /// This run created the directory itself — a clone, or a brand new local
    /// folder that did not exist before. Rollback may delete it wholesale.
    /// `false` for a pre-existing local folder that was only linked; that
    /// folder is the user's, and nothing here ever deletes it.
    pub created_dir: bool,
    /// This run wrote the manifest because the folder had none. Rollback of
    /// a folder that was not `created_dir` still removes just the manifest
    /// it wrote, never anything that was already there.
    pub wrote_manifest: bool,
}

/// What [`run`] can do to the world, injected so the sequencing above is
/// tested without either a filesystem or a network — see the module doc.
pub struct Ops<'a> {
    /// Clone or link the code onto disk, and write a manifest if the folder
    /// does not already have one. Never called for [`CodeSource::
    /// NewGithubRepo`] — `run` skips [`StepId::CloneOrLink`] before this
    /// would be reached.
    pub land_code: &'a dyn Fn(&CodeSource, Kind) -> Result<CodeResult, String>,
    /// Undo [`Self::land_code`]: delete the directory it created, or just the
    /// manifest it wrote into a folder that already existed. Told which by
    /// the [`CodeResult`] it is passed.
    pub unland_code: &'a dyn Fn(&CodeResult) -> Result<(), String>,
    pub is_git_repo: &'a dyn Fn(&Path) -> bool,
    pub create_worktree: &'a dyn Fn(&Path) -> Result<(), String>,
    pub remove_worktree: &'a dyn Fn(&Path) -> Result<(), String>,
    pub open_project: &'a dyn Fn(&Path) -> Result<(), String>,
}

/// Run the plan once, reporting progress after every step settles.
///
/// **A half-made project never reaches Recent.** [`Ops::open_project`] — the
/// one call that can touch the Recent list — is the very last thing `run`
/// does, and only once steps 2 and 7 have either succeeded or been honestly
/// skipped. Every earlier failure returns before `open_project` is ever
/// called, so there is no path through this function that adds an entry for
/// a project that did not finish.
pub fn run(request: &Request, ops: &Ops, mut on_progress: impl FnMut(&Snapshot)) -> Snapshot {
    let mut steps = Snapshot::pending().steps;

    macro_rules! set {
        ($id:expr, $status:expr) => {
            if let Some(found) = steps.iter_mut().find(|s| s.id == $id) {
                found.status = $status;
            }
        };
    }
    macro_rules! emit {
        () => {
            on_progress(&Snapshot {
                steps: steps.clone(),
                running: true,
                opened_path: None,
                failed_step: None,
            });
        };
    }

    // Step 1: the GitHub repo from the template. Nothing here ever calls
    // GitHub — see the module doc.
    set!(StepId::GithubRepo, StepStatus::Skipped(NOT_WIRED.to_string()));
    emit!();

    // Step 2 needs a repository that already exists somewhere reachable.
    // `NewGithubRepo` has nothing to clone until step 1 is real, so it is
    // skipped for the same reason step 1 was.
    let code_result = if let CodeSource::NewGithubRepo = &request.code {
        set!(
            StepId::CloneOrLink,
            StepStatus::Skipped("needs step 1's GitHub repo, which is not wired yet".to_string())
        );
        emit!();
        None
    } else {
        set!(StepId::CloneOrLink, StepStatus::Running);
        emit!();
        match (ops.land_code)(&request.code, request.kind) {
            Ok(result) => {
                set!(
                    StepId::CloneOrLink,
                    StepStatus::Done(result.path.display().to_string())
                );
                emit!();
                Some(result)
            }
            Err(message) => {
                set!(StepId::CloneOrLink, StepStatus::Failed(message));
                skip_the_rest(&mut steps, StepId::CloneOrLink);
                return finish(steps, Some(StepId::CloneOrLink), None);
            }
        }
    };

    for id in [
        StepId::Plane,
        StepId::Registry,
        StepId::Hindsight,
        StepId::ProjectRecord,
    ] {
        set!(id, StepStatus::Skipped(NOT_WIRED.to_string()));
    }
    emit!();

    let worktree_created = match &code_result {
        Some(result) if (ops.is_git_repo)(&result.path) => {
            set!(StepId::DesignWorktree, StepStatus::Running);
            emit!();
            match (ops.create_worktree)(&result.path) {
                Ok(()) => {
                    set!(
                        StepId::DesignWorktree,
                        StepStatus::Done("wt/design".to_string())
                    );
                    emit!();
                    true
                }
                Err(message) => {
                    set!(StepId::DesignWorktree, StepStatus::Failed(message));
                    set!(StepId::OpenProject, StepStatus::Skipped(
                        "the previous step failed".to_string(),
                    ));
                    rollback(&mut steps, ops, &code_result, false);
                    return finish(steps, Some(StepId::DesignWorktree), None);
                }
            }
        }
        Some(_) => {
            set!(
                StepId::DesignWorktree,
                StepStatus::Skipped("not a git repository".to_string())
            );
            false
        }
        None => {
            set!(
                StepId::DesignWorktree,
                StepStatus::Skipped("no local folder to put it in".to_string())
            );
            false
        }
    };
    emit!();

    let Some(result) = &code_result else {
        set!(
            StepId::OpenProject,
            StepStatus::Skipped("no local folder to open".to_string())
        );
        return finish(steps, None, None);
    };

    set!(StepId::OpenProject, StepStatus::Running);
    emit!();
    match (ops.open_project)(&result.path) {
        Ok(()) => {
            set!(
                StepId::OpenProject,
                StepStatus::Done("Design canvas cluster, then \"New cluster\" to start work".to_string())
            );
            finish(steps, None, Some(result.path.display().to_string()))
        }
        Err(message) => {
            set!(StepId::OpenProject, StepStatus::Failed(message));
            rollback(&mut steps, ops, &code_result, worktree_created);
            finish(steps, Some(StepId::OpenProject), None)
        }
    }
}

fn finish(steps: Vec<StepState>, failed_step: Option<StepId>, opened_path: Option<String>) -> Snapshot {
    Snapshot {
        steps,
        running: false,
        opened_path,
        failed_step,
    }
}

/// A step that failed before it could try the worktree or the open never
/// leaves those two `Pending` — that would draw as "still waiting" beside a
/// failure that has already ended the run. Marked `Skipped` instead, with the
/// plain reason, matching how a `notWired` dependency reads.
fn skip_the_rest(steps: &mut [StepState], failed_at: StepId) {
    let index = STEP_ORDER.iter().position(|&id| id == failed_at).unwrap_or(0);
    for &id in STEP_ORDER.iter().skip(index + 1) {
        if let Some(step) = steps.iter_mut().find(|s| s.id == id) {
            if step.status == StepStatus::Pending {
                step.status = StepStatus::Skipped("the previous step failed".to_string());
            }
        }
    }
}

/// Undo what ran, in the reverse of §7's order: the worktree before the code
/// it sits inside of. Only a step that actually completed (`Done`) is
/// touched — a `Skipped` step made nothing, and there is nothing there to
/// undo. Best-effort: a rollback op that itself fails leaves that step
/// `Failed` rather than `RolledBack`, which is the honest answer — "Kaava
/// could not finish undoing this" is not the same claim as "there was
/// nothing here to undo" or "this was undone".
fn rollback(steps: &mut [StepState], ops: &Ops, code_result: &Option<CodeResult>, worktree_created: bool) {
    if worktree_created {
        if let Some(result) = code_result {
            if let Some(step) = steps.iter_mut().find(|s| s.id == StepId::DesignWorktree) {
                match (ops.remove_worktree)(&result.path) {
                    Ok(()) => step.status = StepStatus::RolledBack,
                    Err(message) => step.status = StepStatus::Failed(format!("could not roll back: {message}")),
                }
            }
        }
    }

    if let Some(result) = code_result {
        if let Some(step) = steps.iter_mut().find(|s| s.id == StepId::CloneOrLink) {
            if matches!(step.status, StepStatus::Done(_)) {
                match (ops.unland_code)(result) {
                    Ok(()) => step.status = StepStatus::RolledBack,
                    Err(message) => step.status = StepStatus::Failed(format!("could not roll back: {message}")),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Ops where every closure succeeds and records that it ran, so a test
    /// only has to override the one thing it wants to fail.
    struct Spy {
        landed: RefCell<Vec<String>>,
        unlanded: RefCell<Vec<PathBuf>>,
        worktrees_created: RefCell<Vec<PathBuf>>,
        worktrees_removed: RefCell<Vec<PathBuf>>,
        opened: RefCell<Vec<PathBuf>>,
        land_fails: bool,
        worktree_fails: bool,
        open_fails: bool,
        is_repo: bool,
        landed_created_dir: bool,
        landed_wrote_manifest: bool,
    }

    impl Default for Spy {
        fn default() -> Self {
            Spy {
                landed: RefCell::new(Vec::new()),
                unlanded: RefCell::new(Vec::new()),
                worktrees_created: RefCell::new(Vec::new()),
                worktrees_removed: RefCell::new(Vec::new()),
                opened: RefCell::new(Vec::new()),
                land_fails: false,
                worktree_fails: false,
                open_fails: false,
                is_repo: true,
                landed_created_dir: true,
                landed_wrote_manifest: true,
            }
        }
    }

    impl Spy {
        fn ops(&self) -> Ops<'_> {
            Ops {
                land_code: &|source, _kind| {
                    if self.land_fails {
                        return Err("clone failed".to_string());
                    }
                    let path = match source {
                        CodeSource::ExistingRepo { clone_to, .. } => clone_to.clone(),
                        CodeSource::LocalFolder { path } => path.clone(),
                        CodeSource::NewGithubRepo => unreachable!("run never lands a NewGithubRepo"),
                    };
                    self.landed.borrow_mut().push(path.display().to_string());
                    Ok(CodeResult {
                        path,
                        created_dir: self.landed_created_dir,
                        wrote_manifest: self.landed_wrote_manifest,
                    })
                },
                unland_code: &|result| {
                    self.unlanded.borrow_mut().push(result.path.clone());
                    Ok(())
                },
                is_git_repo: &|_path| self.is_repo,
                create_worktree: &|path| {
                    if self.worktree_fails {
                        return Err("worktree add failed".to_string());
                    }
                    self.worktrees_created.borrow_mut().push(path.to_path_buf());
                    Ok(())
                },
                remove_worktree: &|path| {
                    self.worktrees_removed.borrow_mut().push(path.to_path_buf());
                    Ok(())
                },
                open_project: &|path| {
                    if self.open_fails {
                        return Err("could not open".to_string());
                    }
                    self.opened.borrow_mut().push(path.to_path_buf());
                    Ok(())
                },
            }
        }
    }

    fn local_request(kind: Kind) -> Request {
        Request {
            kind,
            code: CodeSource::LocalFolder {
                path: PathBuf::from("C:/code/torn-apart"),
            },
        }
    }

    fn status_of<'a>(snapshot: &'a Snapshot, id: StepId) -> &'a StepStatus {
        &snapshot.steps.iter().find(|s| s.id == id).unwrap().status
    }

    #[test]
    fn a_clean_run_lands_the_code_cuts_the_worktree_and_opens_it() {
        let spy = Spy::default();
        let snapshot = run(&local_request(Kind::Game), &spy.ops(), |_| {});

        assert!(!snapshot.running);
        assert_eq!(snapshot.failed_step, None);
        assert_eq!(snapshot.opened_path, Some("C:/code/torn-apart".to_string()));
        assert_eq!(spy.opened.borrow().len(), 1);
        assert_eq!(spy.worktrees_created.borrow().len(), 1);
        assert!(matches!(status_of(&snapshot, StepId::CloneOrLink), StepStatus::Done(_)));
        assert!(matches!(status_of(&snapshot, StepId::DesignWorktree), StepStatus::Done(_)));
        assert!(matches!(status_of(&snapshot, StepId::OpenProject), StepStatus::Done(_)));
    }

    /// The five steps this build never wires up are `Skipped`, never
    /// `Failed` — a plan that only ever touches not-wired backends must still
    /// be able to reach a successful open.
    #[test]
    fn the_five_unwired_steps_are_skipped_not_failed() {
        let spy = Spy::default();
        let snapshot = run(&local_request(Kind::Game), &spy.ops(), |_| {});

        for id in [
            StepId::GithubRepo,
            StepId::Plane,
            StepId::Registry,
            StepId::Hindsight,
            StepId::ProjectRecord,
        ] {
            assert!(
                matches!(status_of(&snapshot, id), StepStatus::Skipped(_)),
                "{id:?} should be skipped, was {:?}",
                status_of(&snapshot, id)
            );
        }
    }

    #[test]
    fn a_new_github_repo_source_skips_clone_and_everything_after_it() {
        let spy = Spy::default();
        let request = Request {
            kind: Kind::Game,
            code: CodeSource::NewGithubRepo,
        };
        let snapshot = run(&request, &spy.ops(), |_| {});

        assert_eq!(snapshot.opened_path, None);
        assert_eq!(snapshot.failed_step, None, "a skip is not a failure");
        assert!(spy.landed.borrow().is_empty(), "land_code is never called");
        assert!(matches!(status_of(&snapshot, StepId::CloneOrLink), StepStatus::Skipped(_)));
        assert!(matches!(status_of(&snapshot, StepId::DesignWorktree), StepStatus::Skipped(_)));
        assert!(matches!(status_of(&snapshot, StepId::OpenProject), StepStatus::Skipped(_)));
    }

    #[test]
    fn a_non_repository_folder_skips_the_worktree_but_still_opens() {
        let mut spy = Spy::default();
        spy.is_repo = false;
        let snapshot = run(&local_request(Kind::Tool), &spy.ops(), |_| {});

        assert!(matches!(status_of(&snapshot, StepId::DesignWorktree), StepStatus::Skipped(_)));
        assert_eq!(snapshot.opened_path, Some("C:/code/torn-apart".to_string()));
    }

    #[test]
    fn a_project_never_opens_when_the_clone_fails() {
        let mut spy = Spy::default();
        spy.land_fails = true;
        let snapshot = run(&local_request(Kind::Game), &spy.ops(), |_| {});

        assert_eq!(snapshot.failed_step, Some(StepId::CloneOrLink));
        assert_eq!(snapshot.opened_path, None, "a half-made project never opens");
        assert!(spy.opened.borrow().is_empty());
        assert!(matches!(status_of(&snapshot, StepId::CloneOrLink), StepStatus::Failed(_)));
        assert!(matches!(status_of(&snapshot, StepId::DesignWorktree), StepStatus::Skipped(_)));
    }

    /// Rollback ordering: a worktree failure undoes the worktree (nothing to
    /// undo there, since it never finished) and the clone before it, in that
    /// order — the reverse of the plan.
    #[test]
    fn a_worktree_failure_rolls_back_the_clone_but_not_a_worktree_that_never_finished() {
        let mut spy = Spy::default();
        spy.worktree_fails = true;
        let snapshot = run(&local_request(Kind::Game), &spy.ops(), |_| {});

        assert_eq!(snapshot.failed_step, Some(StepId::DesignWorktree));
        assert_eq!(snapshot.opened_path, None);
        assert_eq!(spy.opened.borrow().len(), 0);
        assert_eq!(
            spy.worktrees_removed.borrow().len(),
            0,
            "the worktree never finished creating, so there is nothing to remove"
        );
        assert_eq!(spy.unlanded.borrow().len(), 1, "the clone is rolled back");
        assert!(matches!(status_of(&snapshot, StepId::CloneOrLink), StepStatus::RolledBack));
        assert!(matches!(status_of(&snapshot, StepId::DesignWorktree), StepStatus::Failed(_)));
    }

    /// Rollback ordering when the *later* step fails: the worktree it made
    /// is undone first, then the clone underneath it — reverse of creation
    /// order, so nothing is ever deleted out from under something that still
    /// depends on it.
    #[test]
    fn an_open_failure_rolls_back_the_worktree_before_the_clone() {
        let mut spy = Spy::default();
        spy.open_fails = true;
        let snapshot = run(&local_request(Kind::Game), &spy.ops(), |_| {});

        assert_eq!(snapshot.failed_step, Some(StepId::OpenProject));
        assert_eq!(snapshot.opened_path, None, "a half-made project never opens");
        assert_eq!(spy.worktrees_removed.borrow().len(), 1);
        assert_eq!(spy.unlanded.borrow().len(), 1);
        assert!(matches!(status_of(&snapshot, StepId::DesignWorktree), StepStatus::RolledBack));
        assert!(matches!(status_of(&snapshot, StepId::CloneOrLink), StepStatus::RolledBack));
    }

    /// A folder that was only linked, not created — [`CodeResult::
    /// created_dir`] false — is never deleted on rollback. `unland_code` is
    /// still called (it is the one place that knows whether to delete the
    /// whole folder or just the manifest), but this test pins the contract
    /// at the type the real `apps::home_create` reads: rollback never
    /// second-guesses `created_dir` itself, it only asks `unland_code` to
    /// honour it.
    #[test]
    fn rollback_always_defers_the_created_dir_decision_to_unland_code() {
        let mut spy = Spy::default();
        spy.landed_created_dir = false;
        spy.open_fails = true;
        run(&local_request(Kind::OpenExisting), &spy.ops(), |_| {});

        assert_eq!(spy.unlanded.borrow().len(), 1);
    }

    #[test]
    fn progress_is_reported_after_every_step_settles() {
        let spy = Spy::default();
        let seen = RefCell::new(Vec::new());
        run(&local_request(Kind::Game), &spy.ops(), |snapshot| {
            seen.borrow_mut().push(snapshot.clone());
        });

        assert!(seen.borrow().len() >= 4, "at least one emit per settled group of steps");
        assert!(seen.borrow().iter().all(|s| s.running));
    }

    #[test]
    fn step_order_lists_all_eight_steps_exactly_once() {
        use std::collections::HashSet;
        let unique: HashSet<StepId> = STEP_ORDER.iter().copied().collect();
        assert_eq!(STEP_ORDER.len(), 8);
        assert_eq!(unique.len(), 8);
    }
}
