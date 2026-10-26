//! The tool side of transport A: what a tool core links against to answer
//! `veistra/*` and its own methods on stdin/stdout.

use crate::codec::{decode_line, write_message, Incoming, Notification, Response, RpcError};
use serde_json::Value;
use std::io::{self, BufRead};

/// What a tool core implements to answer everything the protocol doesn't
/// already own. `serve` intercepts `veistra/shutdown` itself (replies, then
/// returns) so every tool doesn't have to reimplement that; `veistra/hello`
/// and every tool-defined method still reach `call` here.
pub trait Handler {
    /// Called one request at a time from the `serve` loop, so `&mut self` state
    /// needs no lock of its own. An unrecognised method is an `RpcError`, not a
    /// panic: the error becomes the reply and the loop keeps serving.
    fn call(&mut self, method: &str, params: Option<Value>) -> Result<Value, RpcError>;
}

/// Send a notification on stdout.
///
/// Safe to call from any thread, which is the point: a tool that pushes
/// events -- a file watcher, a build progress reporter -- does that work off
/// the `serve` loop, so the interesting callers are exactly the ones that
/// aren't `Handler::call`. The lock is held for the whole message rather than
/// per write, because `write_message` writes the JSON and the terminating
/// newline separately; without it, two threads can interleave mid-message and
/// hand the host a corrupt line. `serve` holds no stdout lock while a handler
/// runs, so locking here can't deadlock against it.
///
/// Called from inside `Handler::call`, the notification still lands before
/// that call's own reply, since `serve` writes the response only after `call`
/// returns.
pub fn notify(method: &str, params: Option<Value>) -> io::Result<()> {
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    write_message(&mut handle, &Notification::new(method, params))
}

/// Read stdin, dispatch, write stdout. Returns when stdin closes (the
/// host's cue for a tool to exit -- see docs/tool-protocol.md section 2) or
/// once `veistra/shutdown` has been answered, whichever happens first.
pub fn serve<H: Handler>(mut handler: H) -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();

    // Each response takes the stdout lock for the length of one message and
    // then drops it -- the same discipline `notify` uses, so a notification
    // from another thread can land between two responses but never inside
    // one. Deliberately not hoisted out of the loop: holding it across
    // `handler.call` would block any notifying thread for the whole handler.
    let write = |msg: &Response| -> io::Result<()> {
        let mut handle = stdout.lock();
        write_message(&mut handle, msg)
    };

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let request = match decode_line(&line) {
            Ok(Incoming::Request(req)) => req,
            Ok(Incoming::Notification(_)) | Ok(Incoming::Response(_)) => {
                // The host never sends a tool either shape: notifications
                // and (in this stub) requests both only flow tool->host.
                // Log and keep serving rather than treat it as fatal, same
                // policy as the malformed-line case below.
                eprintln!("veistra-rpc: ignoring unexpected notification/response on stdin");
                continue;
            }
            Err(err) => {
                // No request id to reply to, so there's nothing to answer --
                // log to stderr (stdout is protocol-only, see section 2) and
                // keep serving instead of exiting over one bad line.
                eprintln!("veistra-rpc: dropping malformed line: {err}");
                continue;
            }
        };

        if request.method == "veistra/shutdown" {
            write(&Response::ok(request.id, Value::Null))?;
            return Ok(());
        }

        let response = match handler.call(&request.method, request.params) {
            Ok(result) => Response::ok(request.id, result),
            Err(err) => Response::err(request.id, err),
        };
        write(&response)?;
    }

    Ok(())
}
