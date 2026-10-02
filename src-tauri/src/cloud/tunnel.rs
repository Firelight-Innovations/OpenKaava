//! The IAP tunnel to `plane-vm`: `OPENKAAVA-PLANE-DESIGN.md` §5.2 / §11 B2.2.
//!
//! One `gcloud compute start-iap-tunnel` child, kept alive for the life of
//! the app: restarted if it exits on its own, and killed — the whole process
//! tree, not just the wrapper — when the app does. Managed as
//! `tauri::State<Tunnel>`; `lib.rs`'s `RunEvent::Exit` handler calls
//! [`Tunnel::stop`].
//!
//! **Not exercised against a real `gcloud`** — B2.2's acceptance ("tunnel is
//! up while the app runs; no `gcloud` process remains after exit") needs a
//! live run, which this PR does not do (see the hard rule against live cloud
//! calls). [`command_line`] and [`taskkill_args`] are the pure pieces this
//! covers with a test; the spawn-and-supervise loop is exercised by reading,
//! not by a test that would need a process tree of its own to assert against.

use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

/// design §11 B2.2, the target port and endpoint.
const TARGET_PORT: &str = "8765";
const ZONE: &str = "us-central1-a";
const INSTANCE: &str = "plane-vm";

/// If `gcloud` exits (crash, network blip, the owner's laptop sleeping),
/// wait this long before trying again rather than spinning a tight loop of
/// failed spawns.
const RESTART_DELAY: Duration = Duration::from_secs(3);

/// The argv `start-iap-tunnel` is called with, everything after the program
/// name. Pure and tested on its own, since building the real [`Command`]
/// mixes this with platform-specific wrapping (see [`spawn`]).
pub fn command_line(project: &str) -> Vec<String> {
    vec![
        "compute".to_string(),
        "start-iap-tunnel".to_string(),
        INSTANCE.to_string(),
        TARGET_PORT.to_string(),
        format!("--local-host-port=localhost:{TARGET_PORT}"),
        format!("--zone={ZONE}"),
        format!("--project={project}"),
    ]
}

/// Everything a running tunnel needs to be stopped: the flag the supervisor
/// thread checks between restarts, and the child's pid so [`Tunnel::stop`]
/// can kill it without waiting for the thread that owns the `Child` to
/// notice.
struct Handle {
    stop: Arc<AtomicBool>,
    pid: Arc<Mutex<Option<u32>>>,
    thread: JoinHandle<()>,
}

/// Held in `tauri::State`. Empty until [`Tunnel::start`] is called once, at
/// app setup; a second call while one is already running is a no-op rather
/// than a second supervisor racing the first over the same port.
#[derive(Default)]
pub struct Tunnel {
    handle: Mutex<Option<Handle>>,
}

impl Tunnel {
    /// Start the supervisor thread, unless one is already running.
    pub fn start(&self, project: String) {
        let mut slot = self.handle.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_some() {
            return;
        }
        let stop = Arc::new(AtomicBool::new(false));
        let pid = Arc::new(Mutex::new(None));
        let thread_stop = stop.clone();
        let thread_pid = pid.clone();
        let thread = std::thread::spawn(move || supervise(&project, &thread_stop, &thread_pid));
        *slot = Some(Handle { stop, pid, thread });
    }

    /// Stop the supervisor and kill whatever `gcloud` it is currently
    /// running, tree and all. Idempotent: called from `RunEvent::Exit`, which
    /// fires once for the app, but safe to call again.
    pub fn stop(&self) {
        let taken = self.handle.lock().unwrap_or_else(|e| e.into_inner()).take();
        let Some(handle) = taken else {
            return;
        };
        handle.stop.store(true, Ordering::SeqCst);
        if let Some(pid) = *handle.pid.lock().unwrap_or_else(|e| e.into_inner()) {
            kill_tree(pid);
        }
        // The supervisor thread's `child.wait()` unblocks once the process
        // above is gone, then sees `stop` and returns — so this join is
        // bounded, not a hang, and it is what makes "no gcloud process
        // remains after exit" true of *this* function rather than of
        // whatever happened to run before the app got around to exiting.
        let _ = handle.thread.join();
    }

    /// Whether a tunnel is currently supervised. Only the tests read it now:
    /// `projects/plane-*` goes through the `kaava-api` gateway, not the tunnel.
    #[cfg(test)]
    pub fn is_running(&self) -> bool {
        self.handle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }
}

fn supervise(project: &str, stop: &Arc<AtomicBool>, pid_slot: &Arc<Mutex<Option<u32>>>) {
    let args = command_line(project);
    while !stop.load(Ordering::SeqCst) {
        match spawn(&args) {
            Ok(mut child) => {
                *pid_slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(child.id());
                // Blocks until `gcloud` exits — on its own, or because
                // `stop` just killed it. Either way this returns.
                let _ = child.wait();
                *pid_slot.lock().unwrap_or_else(|e| e.into_inner()) = None;
            }
            Err(e) => {
                crate::kaava_log!("could not start the IAP tunnel: {e}");
            }
        }
        if stop.load(Ordering::SeqCst) {
            return;
        }
        std::thread::sleep(RESTART_DELAY);
    }
}

/// `gcloud` on Windows is `gcloud.cmd`, a batch script that in turn launches
/// Python — see the handoff and `cloud::auth`'s own note on the same
/// program. A one-shot call there is content to invoke `gcloud.cmd` directly
/// and let `Command::output` wait for the whole chain to finish; a
/// long-lived tunnel is not, because stopping it means killing every
/// process in that chain, and `Child::kill` on the direct child only ever
/// reaches the wrapper. Going through `cmd /c` explicitly makes that chain
/// the one thing [`kill_tree`] has to reason about, on every launch, rather
/// than trusting Windows' own implicit `.cmd` handling to shape it the same
/// way every time.
#[cfg(windows)]
fn spawn(args: &[String]) -> std::io::Result<Child> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = Command::new("cmd");
    command.arg("/c").arg("gcloud.cmd").args(args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    command.spawn()
}

#[cfg(not(windows))]
fn spawn(args: &[String]) -> std::io::Result<Child> {
    let mut command = Command::new("gcloud");
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.spawn()
}

/// The whole tree under `pid`, not just it: `taskkill /T` walks descendants,
/// which is what reaches the Python process `cmd /c gcloud.cmd` actually
/// runs — killing only the `cmd.exe` (or, without the wrapper, only
/// `gcloud.cmd`'s own top process) leaves the tunnel itself listening.
#[cfg(windows)]
fn taskkill_args(pid: u32) -> Vec<String> {
    vec![
        "/T".to_string(),
        "/F".to_string(),
        "/PID".to_string(),
        pid.to_string(),
    ]
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let result = Command::new("taskkill")
        .args(taskkill_args(pid))
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    if let Err(e) = result {
        crate::kaava_log!("could not stop the IAP tunnel (pid {pid}): {e}");
    }
}

#[cfg(not(windows))]
fn kill_tree(pid: u32) {
    // No `cmd /c` wrapper off Windows, so the pid this holds is `gcloud`
    // itself; a plain kill reaches it. Not the platform B2.2 targets, so
    // this is the minimal answer rather than a second tree-walk to maintain.
    let _ = Command::new("kill").arg(pid.to_string()).output();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_line_names_the_pinned_vm_port_and_project() {
        let args = command_line("veistra-prod");
        assert_eq!(
            args,
            vec![
                "compute",
                "start-iap-tunnel",
                "plane-vm",
                "8765",
                "--local-host-port=localhost:8765",
                "--zone=us-central1-a",
                "--project=veistra-prod",
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn taskkill_targets_the_whole_tree_and_does_not_ask_first() {
        assert_eq!(taskkill_args(4242), vec!["/T", "/F", "/PID", "4242"]);
    }

    #[test]
    fn a_tunnel_with_nothing_started_reports_not_running() {
        let tunnel = Tunnel::default();
        assert!(!tunnel.is_running());
        // Stopping one that was never started must not panic.
        tunnel.stop();
    }
}
