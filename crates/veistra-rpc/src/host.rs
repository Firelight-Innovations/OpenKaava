//! The host side of transport A: spawn a tool binary, speak the codec on
//! its stdin/stdout, and hand back a handle callers use like a synchronous
//! RPC client even though two background threads are doing the actual I/O.

use crate::codec::{
    decode_line, write_message, Incoming, Notification, Request, RpcError, TIMED_OUT, TOOL_EXITED,
};
use crate::sync::MutexExt;
use serde_json::Value;
use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Default budget for `call`. `call_timeout` exists for callers that need a
/// tighter bound (or, in tests, a much tighter one so a stuck test fails
/// fast instead of sitting for 30s).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long `shutdown` waits after `veistra/shutdown` replies before it kills
/// the process itself. Mirrors docs/tool-protocol.md section 2.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// One entry per in-flight `call`/`call_timeout`, keyed by request id: the
/// reader thread removes an entry and fires its sender when the matching
/// response (or, on EOF, a synthetic `TOOL_EXITED`) arrives.
type PendingCalls = Arc<Mutex<HashMap<u64, Sender<Result<Value, RpcError>>>>>;

/// Everything that can fail while getting a tool process up, plus the
/// process-level failures `shutdown` can hit. Failures of an individual call
/// travel as `RpcError` instead, so this never appears mid-conversation.
#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    /// The OS refused to start the binary at all -- missing file, not
    /// executable, bad `cwd`. Nothing was spawned, so there is no child to
    /// clean up.
    #[error("failed to spawn tool binary {}: {source}", bin.display())]
    Spawn {
        /// The path exactly as handed to `spawn`, so the message can name it
        /// without the caller threading it back through.
        bin: PathBuf,
        /// Kept as `#[source]` so callers can match on `io::ErrorKind` rather
        /// than parse the rendered message.
        #[source]
        source: std::io::Error,
    },
    /// A piped stdio handle came back `None`. `spawn` pipes all three and
    /// takes each exactly once, so this should be unreachable; it exists so
    /// that path is a typed error instead of an unwrap.
    #[error("child process did not provide a {stream} handle")]
    MissingStream {
        /// Which handle was missing (`"stdin"`, `"stdout"`, `"stderr"`) --
        /// the only thing separating three otherwise identical failures.
        stream: &'static str,
    },
    /// I/O trouble once the process is already running. Only `shutdown`
    /// produces it, from `try_wait` or `kill`.
    #[error("i/o error talking to tool process: {0}")]
    Io(#[source] std::io::Error),
}

/// A running tool core, reachable as if `call` were a normal blocking
/// function call even though the reply travels through a background thread.
///
/// `pending` is the hinge everything turns on: `call_timeout` inserts a
/// sender keyed by request id before writing the request, and the reader
/// thread below removes and fires that sender when the matching response
/// (or, on EOF, a synthetic failure) shows up. Because insertion happens
/// before the write, there's no window where a response could arrive before
/// anyone is watching for it.
pub struct ToolProcess {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: PendingCalls,
    next_id: AtomicU64,
    // Behind a `Mutex` purely to keep `ToolProcess` itself `Sync`.
    // `mpsc::Receiver` is `Send` but deliberately `!Sync`, and a struct
    // holding one is `!Sync` too — which would mean this type could never go
    // into Tauri's managed state, since `.manage()` requires `Send + Sync +
    // 'static`. The broker's whole job is holding these and serving calls
    // from whatever thread a command lands on, so that restriction would
    // surface as a rewrite exactly when the type starts being used for real.
    // `Mutex<Receiver<_>>` is `Sync`, and the lock costs nothing here: it
    // still enforces one consumer at a time, which is what the ordering
    // guarantee needed anyway.
    notifications: Mutex<Receiver<Notification>>,
    // Plain `Option<JoinHandle<_>>`, not behind a `Mutex`: `Drop::drop` takes
    // `&mut self`, which already gives exclusive access, so there's nothing
    // for a `Mutex` to protect here.
    reader_handle: Option<JoinHandle<()>>,
    stderr_handle: Option<JoinHandle<()>>,
}

impl ToolProcess {
    /// Spawn the tool binary and start the reader threads. `label` tags the
    /// tool's stderr lines in the orchestrator's own log output, so a
    /// multi-tool session doesn't produce an unattributed stream of noise.
    pub fn spawn(bin: &Path, args: &[String], cwd: &Path, label: &str) -> Result<Self, SpawnError> {
        let mut child = Command::new(bin)
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|source| SpawnError::Spawn {
                bin: bin.to_path_buf(),
                source,
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or(SpawnError::MissingStream { stream: "stdin" })?;
        let stdout = child
            .stdout
            .take()
            .ok_or(SpawnError::MissingStream { stream: "stdout" })?;
        let stderr = child
            .stderr
            .take()
            .ok_or(SpawnError::MissingStream { stream: "stderr" })?;

        let pending: PendingCalls = Arc::new(Mutex::new(HashMap::new()));
        let (notif_tx, notif_rx) = mpsc::channel();

        // A tool that logs a lot writes to a pipe with a finite OS buffer.
        // If nothing ever reads the other end, the tool's own `eprintln!`
        // blocks once that buffer fills -- and if that happens while the
        // tool is mid-handler, it can never get back to reading stdin or
        // writing its response, which looks like a hung tool with a
        // completely unrelated root cause. Draining stderr on its own
        // thread, continuously, is what keeps that pipe from ever backing
        // up regardless of how chatty the tool is.
        let stderr_label = label.to_string();
        let stderr_handle = thread::spawn(move || {
            for line in std::io::BufReader::new(stderr).lines() {
                match line {
                    Ok(line) => eprintln!("[{stderr_label}] {line}"),
                    Err(_) => break,
                }
            }
        });

        let reader_label = label.to_string();
        let reader_pending = Arc::clone(&pending);
        let reader_handle = thread::spawn(move || {
            for line in std::io::BufReader::new(stdout).lines() {
                let line = match line {
                    Ok(line) => line,
                    Err(_) => break, // stdout gone; fall through to the EOF handling below
                };
                if line.trim().is_empty() {
                    continue;
                }
                match decode_line(&line) {
                    Ok(Incoming::Response(resp)) => {
                        let sender = reader_pending.lock_or_panic().remove(&resp.id);
                        if let Some(tx) = sender {
                            let _ = tx.send(resp.into_result());
                        }
                        // No entry: either `call_timeout` already gave up and
                        // removed it, or the tool echoed an id nobody sent.
                        // Either way there's no one left to deliver to.
                    }
                    Ok(Incoming::Notification(n)) => {
                        let _ = notif_tx.send(n);
                    }
                    Ok(Incoming::Request(_)) => {
                        // Every method this stub exercises flows host->tool;
                        // nothing here ever answers a tool-initiated request.
                        // Log and ignore rather than tear the process down --
                        // same call as the malformed-line case just below.
                        eprintln!(
                            "[{reader_label}] tool sent a host-directed request, which this host does not serve; ignoring"
                        );
                    }
                    Err(err) => {
                        // A line that doesn't parse is a protocol violation
                        // by the tool, not grounds to kill it out from under
                        // whatever else it's doing -- log to stderr and keep
                        // reading. The alternative (tearing down the process)
                        // turns one bad log line into every in-flight call
                        // failing, which is a worse failure mode than one
                        // dropped line.
                        eprintln!("[{reader_label}] dropping malformed line: {err}");
                    }
                }
            }

            // EOF: the tool exited (or crashed). Every call still waiting on
            // a reply needs to hear about it, or it hangs forever with no
            // error anywhere -- which is exactly the failure mode that
            // presents as a frozen UI. `mem::take` swaps in a fresh empty
            // map and hands back the old one while the lock is held, so the
            // actual sends happen after the lock is released rather than
            // while a `call_timeout` on another thread might be blocked
            // trying to acquire it to remove its own entry.
            let stranded = std::mem::take(&mut *reader_pending.lock_or_panic());
            for (_, tx) in stranded {
                let _ = tx.send(Err(RpcError::new(TOOL_EXITED, "tool process exited")));
            }
        });

        Ok(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending,
            next_id: AtomicU64::new(1),
            notifications: Mutex::new(notif_rx),
            reader_handle: Some(reader_handle),
            stderr_handle: Some(stderr_handle),
        })
    }

    /// `call_timeout` under `DEFAULT_TIMEOUT`, which is what nearly every
    /// caller wants; reach for the explicit form only when 30s is too long to
    /// wait on this particular method.
    pub fn call(&self, method: &str, params: Option<Value>) -> Result<Value, RpcError> {
        self.call_timeout(method, params, DEFAULT_TIMEOUT)
    }

    /// Blocks the calling thread until the reader thread delivers a reply, the
    /// tool exits (`TOOL_EXITED`), or `timeout` elapses (`TIMED_OUT`). A
    /// timeout abandons the request rather than cancelling it, so the tool may
    /// still be working and any late reply is dropped. Safe to call from many
    /// threads: ids are atomic and each caller waits on its own channel.
    pub fn call_timeout(
        &self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        // Insert before writing: a response can only arrive after the write
        // lands on the tool's stdin and it replies, so the entry is already
        // in the map by the time that's possible.
        self.pending.lock_or_panic().insert(id, tx);

        let request = Request::new(id, method, params);
        let write_result = {
            let mut stdin = self.stdin.lock_or_panic();
            write_message(&mut *stdin, &request)
        };
        if let Err(e) = write_result {
            self.pending.lock_or_panic().remove(&id);
            return Err(RpcError::new(
                TOOL_EXITED,
                format!("failed to write request to tool stdin: {e}"),
            ));
        }

        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                // Remove our own entry so a reply that shows up after this
                // point finds nothing in the map (the reader thread's "no
                // entry" branch above) instead of the map accumulating one
                // dead sender per timeout for the life of the process.
                self.pending.lock_or_panic().remove(&id);
                Err(RpcError::new(
                    TIMED_OUT,
                    format!("{method} timed out after {timeout:?}"),
                ))
            }
        }
    }

    /// Notifications pushed by the tool, in arrival order.
    ///
    /// Only the reader thread owned by `spawn` ever sends, so ordering falls
    /// out of the channel for free. The returned guard derefs to the
    /// `Receiver`, so `tool.notifications().recv_timeout(..)` reads the same
    /// as it would on a bare receiver — it just also enforces one consumer at
    /// a time. Hold it no longer than a single `recv`: keeping it across a
    /// long wait blocks any other thread trying to drain the same tool.
    pub fn notifications(&self) -> std::sync::MutexGuard<'_, Receiver<Notification>> {
        self.notifications.lock_or_panic()
    }

    /// `veistra/shutdown`, then wait, then kill. Idempotent: a second call
    /// finds the child already reaped (`try_wait` keeps returning the same
    /// exit status once obtained) and returns immediately.
    pub fn shutdown(&self) -> Result<(), SpawnError> {
        // Best-effort: if the tool already exited this fails with
        // TOOL_EXITED, which is fine -- there's nothing left to negotiate,
        // so fall through to reaping below regardless of the outcome.
        let _ = self.call_timeout("veistra/shutdown", None, SHUTDOWN_GRACE);

        let deadline = Instant::now() + SHUTDOWN_GRACE;
        loop {
            let mut child = self.child.lock_or_panic();
            match child.try_wait().map_err(SpawnError::Io)? {
                Some(_status) => return Ok(()),
                None if Instant::now() >= deadline => {
                    child.kill().map_err(SpawnError::Io)?;
                    let _ = child.wait();
                    return Ok(());
                }
                None => {
                    drop(child);
                    thread::sleep(Duration::from_millis(20));
                }
            }
        }
    }
}

impl Drop for ToolProcess {
    /// Kill the child so a dropped `ToolProcess` can never orphan a process
    /// -- even if the caller never called `shutdown` (a panic unwinding
    /// through an owner, say).
    ///
    /// Order matters: killing first is what makes the joins below finish
    /// promptly. `kill` closes the child's stdout and stderr, and both
    /// reader threads are sitting in a blocking read on those handles --
    /// closing them is what wakes the threads up so they can reach EOF and
    /// return. Joining before killing would just wait forever on a tool
    /// that never exits on its own.
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait(); // reap, so the OS process table doesn't keep a zombie
        }
        if let Some(handle) = self.reader_handle.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.stderr_handle.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ToolProcess;

    /// Compiles or it doesn't — there's nothing to assert at runtime.
    ///
    /// The broker will keep `ToolProcess` in Tauri's managed state, and
    /// `.manage()` requires `Send + Sync + 'static`. Losing `Sync` is easy to
    /// do by accident (an `mpsc::Receiver` held bare is `!Sync` and makes the
    /// whole struct `!Sync`) and the failure would land far from the cause,
    /// so it's worth catching in this crate rather than in the orchestrator.
    #[test]
    fn is_send_sync_for_tauri_managed_state() {
        fn assert<T: Send + Sync + 'static>() {}
        assert::<ToolProcess>();
    }
}
