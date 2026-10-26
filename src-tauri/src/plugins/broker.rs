//! The broker: one plugin's frontend asking a question its own core answers.
//!
//! A relay and not a translator: nothing here inspects a payload or enumerates a
//! method, because the vocabulary belongs to the plugin, not to the protocol.
//! Mostly lifecycle, therefore — when a core starts, when it stops, and what
//! happens to a call that arrives while it is neither.
//!
//! `docs/design-notes/backend-plugins.md` has what this is, the two things it
//! deliberately does not do yet (cross-plugin calls, and a core's
//! notifications), and why `pty.rs` was not reused for the child process.

use crate::plugins::{self, Registry};
use crate::sync::MutexExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use veistra_rpc::{RpcError, ToolProcess, HANDSHAKE_FAILED, INTERNAL_ERROR, METHOD_NOT_FOUND};
use veistra_tool_manifest::ToolManifest;

/// The protocol version this shell speaks. A core answering anything else is
/// rejected at the handshake rather than negotiated down — see
/// `docs/tool-protocol.md` §6, "a shell and a tool from two majors half-working
/// is a worse day than either of them stopping at the handshake".
const PROTOCOL: u32 = 1;

/// Running plugin cores, keyed by package id. Managed state, registered in
/// `lib.rs`.
///
/// **One core per package, not per surface.** Two surfaces of one plugin are
/// views over one domain; a process each would be two copies of that domain's
/// state with nothing keeping them honest. `CoreSection`'s doc makes the same
/// argument from the manifest's side.
///
/// `Arc<ToolProcess>` so a call can clone the handle out and release this lock
/// before it blocks on the child. Holding a `Mutex` across a round trip to
/// another process would serialize every plugin in the application behind the
/// slowest one, and deadlock outright if a core's answer needed the shell.
#[derive(Default)]
pub struct Broker {
    cores: Mutex<HashMap<String, Arc<ToolProcess>>>,
}

impl Broker {
    /// Send one method to a package's core, starting it if it is not running.
    ///
    /// Lazy rather than started at install or at boot, and that is the whole
    /// lifecycle policy: a plugin whose surfaces nobody has opened costs no
    /// process. It also means the first call after a rebuild spawns the *new*
    /// binary with nothing to invalidate — which is what [`stop`](Self::stop)
    /// leans on to make reloading a plugin a one-line operation.
    pub fn route(
        &self,
        app: &AppHandle,
        package_id: &str,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, RpcError> {
        if is_reserved(method) {
            return Err(RpcError::new(
                METHOD_NOT_FOUND,
                format!("`{method}` is reserved by the protocol and is not forwarded to a core"),
            ));
        }

        let core = self.core(app, package_id)?;
        core.call(method, params)
    }

    /// Stop a package's core if it is running. Safe to call when it is not.
    ///
    /// `ToolProcess::shutdown` asks over the wire first and kills after a grace
    /// period, so a core gets its chance to flush. Dropping the last `Arc`
    /// afterwards reaps the child and joins its two reader threads.
    ///
    /// Nothing is marked dead: the entry is simply removed, so the next call
    /// spawns fresh. "Stopped" and "never started" are the same state here on
    /// purpose — a third one would need a rule for when it clears.
    pub fn stop(&self, package_id: &str) {
        let core = self.cores.lock_or_panic().remove(package_id);
        if let Some(core) = core {
            if let Err(e) = core.shutdown() {
                eprintln!("veistra: {package_id} did not shut down cleanly: {e}");
            }
        }
    }

    /// Stop every running core. For application exit.
    pub fn stop_all(&self) {
        let ids: Vec<String> = self.cores.lock_or_panic().keys().cloned().collect();
        for id in ids {
            self.stop(&id);
        }
    }

    /// Whether a package's core is running right now. For the install list.
    pub fn is_running(&self, package_id: &str) -> bool {
        self.cores.lock_or_panic().contains_key(package_id)
    }

    /// The running core for a package, spawning and shaking hands if needed.
    fn core(&self, app: &AppHandle, package_id: &str) -> Result<Arc<ToolProcess>, RpcError> {
        if let Some(core) = self.cores.lock_or_panic().get(package_id) {
            return Ok(Arc::clone(core));
        }

        // Spawned *outside* the lock, because it starts a process and then
        // blocks on a round trip for the handshake. Holding the map across that
        // would stall every other plugin's calls behind this one starting up.
        //
        // The cost is that two calls racing for a cold core can both spawn one.
        // Resolved below by keeping whichever lands first and shutting the other
        // down, which is a rare wasted process rather than a permanent leak —
        // and much cheaper than the alternative, which is holding the lock.
        let spawned = Arc::new(spawn(app, package_id)?);

        let mut cores = self.cores.lock_or_panic();
        match cores.get(package_id) {
            Some(winner) => {
                let winner = Arc::clone(winner);
                drop(cores);
                if let Err(e) = spawned.shutdown() {
                    eprintln!("veistra: could not stop a duplicate {package_id} core: {e}");
                }
                Ok(winner)
            }
            None => {
                cores.insert(package_id.to_string(), Arc::clone(&spawned));
                Ok(spawned)
            }
        }
    }
}

/// Whether a method belongs to the protocol rather than to a plugin.
///
/// The `veistra/` prefix is reserved on both transports. A core is required to
/// implement `veistra/hello` and `veistra/shutdown` and forbidden to define anything
/// else under it, so forwarding one would either duplicate a handshake this
/// module owns or reach a method the protocol says cannot exist.
fn is_reserved(method: &str) -> bool {
    method.starts_with("veistra/")
}

/// Start a package's core and complete `veistra/hello`.
///
/// Every failure here is an [`RpcError`] rather than a log line, because the
/// caller is a frontend waiting on an `invoke` — a plugin that cannot start has
/// to say so in the surface that asked, not only in a terminal nobody is
/// watching. `docs/tool-protocol.md` §6 is explicit that an immediate error
/// beats the bridge's thirty-second timeout.
fn spawn(app: &AppHandle, package_id: &str) -> Result<ToolProcess, RpcError> {
    let Some(checkout) = app.state::<Registry>().path_of(package_id) else {
        return Err(RpcError::new(
            INTERNAL_ERROR,
            format!("`{package_id}` is not installed"),
        ));
    };

    let manifest = ToolManifest::load(&checkout)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("veistra-tool.toml: {e}")))?;

    let Some(core) = manifest.core.as_ref() else {
        // A frontend-only package. Worth naming precisely: the surface loaded
        // and drew, so "it does not work" is not the diagnosis — the plugin
        // simply has no Rust half to answer this.
        return Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("`{package_id}` declares no [core]; it has no backend to answer this"),
        ));
    };

    let bin = manifest.resolve_bin(&checkout).map_err(|e| {
        // Overwhelmingly the "you have not built it yet" case, so the message
        // says that before it says the path.
        RpcError::new(INTERNAL_ERROR, format!("`{package_id}` is not built: {e}"))
    })?;

    let process = ToolProcess::spawn(&bin, &core.args, &checkout, package_id).map_err(|e| {
        RpcError::new(
            INTERNAL_ERROR,
            format!("could not start `{package_id}`: {e}"),
        )
    })?;

    handshake(&process, package_id, &manifest)?;
    Ok(process)
}

/// `veistra/hello`, and the two checks the protocol says the host owes.
///
/// Specified since v1 and enforced nowhere until now: `HANDSHAKE_FAILED` existed
/// in `veistra-rpc` and nothing raised it, because the code that would is this.
/// Both checks refuse rather than negotiate — a core built against a different
/// major, or one whose identity does not match the manifest it was found beside,
/// is a mismatch that gets worse the longer it runs.
fn handshake(
    process: &ToolProcess,
    package_id: &str,
    manifest: &ToolManifest,
) -> Result<(), RpcError> {
    // `session.projectPath` is null in every build that exists — see
    // `docs/tool-protocol.md` §3, "Session". Sent as the specified shape anyway
    // so a core parsing it strictly today keeps working when it is filled in.
    let reply = process.call(
        "veistra/hello",
        Some(json!({ "protocol": PROTOCOL, "session": { "projectPath": null } })),
    )?;

    check_hello(&reply, package_id, &manifest.tool.id)
}

/// The two checks, over a reply that has already arrived.
///
/// Split from the round trip so they can be tested without a child process —
/// which matters more than usual here, because the failing cases are exactly the
/// ones no cooperating tool will ever produce. A core that answers correctly is
/// covered end to end by `examples/echo-tool/tests/roundtrip.rs`; a core that
/// lies about its protocol or its id can only be written as a literal.
fn check_hello(reply: &Value, package_id: &str, manifest_id: &str) -> Result<(), RpcError> {
    let spoken = reply.get("protocol").and_then(Value::as_u64);
    if spoken != Some(u64::from(PROTOCOL)) {
        return Err(RpcError::new(
            HANDSHAKE_FAILED,
            format!(
                "`{package_id}` speaks protocol {}, this build speaks {PROTOCOL}",
                spoken.map_or_else(|| "nothing".to_string(), |v| v.to_string())
            ),
        ));
    }

    let claimed = reply.get("id").and_then(Value::as_str);
    if claimed != Some(manifest_id) {
        return Err(RpcError::new(
            HANDSHAKE_FAILED,
            format!(
                "`{package_id}` answered the handshake as {:?}, but its veistra-tool.toml says {manifest_id:?}",
                claimed.unwrap_or("nothing"),
            ),
        ));
    }

    Ok(())
}

/// Route one call from a mounted surface to its package's core.
///
/// `surface_address` is what the shell holds in an app id's position — the
/// package half is taken from it here rather than accepted as a parameter,
/// which is what bounds a frame to its own core. The shell resolved that address
/// from `event.source` against its own map of mounted iframes, so it is the one
/// input on this path a plugin cannot forge.
pub fn call(
    app: &AppHandle,
    surface_address: &str,
    method: &str,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let Some((package_id, _surface_id)) = plugins::split_address(surface_address) else {
        return Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("`{surface_address}` names neither an app nor a plugin surface"),
        ));
    };

    app.state::<Broker>().route(app, package_id, method, params)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two the protocol names, plus the space it reserves around them. A
    /// core that defined `veistra/save` would be violating §2, and the shell
    /// refusing to forward it is what keeps that a plugin's bug rather than a
    /// silent second handshake.
    #[test]
    fn the_protocol_namespace_is_never_forwarded() {
        assert!(is_reserved("veistra/hello"));
        assert!(is_reserved("veistra/shutdown"));
        assert!(is_reserved("veistra/anything-else"));
    }

    /// A plugin's own vocabulary crosses untouched — the broker is a relay, not
    /// a translator, and a method that merely *mentions* the reserved word is
    /// still the plugin's.
    #[test]
    fn a_plugins_own_methods_are_forwarded() {
        assert!(!is_reserved("specs/load"));
        assert!(!is_reserved("echo"));
        assert!(!is_reserved("graph/veistra/nested"));
        assert!(!is_reserved("veistramainen/list"));
    }

    #[test]
    fn stopping_a_core_that_never_started_is_not_an_error() {
        let broker = Broker::default();
        broker.stop("never-ran");
        broker.stop_all();
        assert!(!broker.is_running("never-ran"));
    }

    // --- the handshake the protocol says the host owes -----------------------

    /// The shape `examples/echo-tool` actually replies with, asserted against
    /// there in `roundtrip.rs`. If that reply ever changes, one of these two
    /// tests fails rather than both passing against different expectations.
    #[test]
    fn a_correct_reply_is_accepted() {
        let reply = json!({"id": "echo", "version": "0.1.0", "protocol": 1});
        assert!(check_hello(&reply, "echo", "echo").is_ok());
    }

    /// Refused rather than negotiated down. `docs/tool-protocol.md` §6: a shell
    /// and a tool from two majors half-working is a worse day than either of
    /// them stopping at the handshake.
    #[test]
    fn a_different_protocol_major_is_refused() {
        let reply = json!({"id": "echo", "protocol": 2});
        let err = check_hello(&reply, "echo", "echo").expect_err("protocol 2 is not protocol 1");
        assert_eq!(err.code, HANDSHAKE_FAILED);
        assert!(err.message.contains("speaks protocol 2"), "{}", err.message);
    }

    /// A core whose identity disagrees with the manifest it was found beside.
    /// Its surfaces are addressed under the manifest's id, so a core answering
    /// to another name is one nothing could route to correctly.
    #[test]
    fn an_id_disagreeing_with_the_manifest_is_refused() {
        let reply = json!({"id": "something-else", "protocol": 1});
        let err = check_hello(&reply, "acme", "acme").expect_err("ids disagree");
        assert_eq!(err.code, HANDSHAKE_FAILED);
        assert!(err.message.contains("something-else"), "{}", err.message);
    }

    /// A reply with neither field — an empty object, or a core that answered
    /// `veistra/hello` with `null` because it does not implement it. Named
    /// explicitly because the `Option` comparisons above make it easy to write
    /// this check in a way that accepts a missing field.
    #[test]
    fn a_reply_missing_the_fields_is_refused() {
        for reply in [json!({}), json!(null), json!({"id": "echo"})] {
            let err = check_hello(&reply, "echo", "echo")
                .expect_err("a reply without a protocol is not a handshake");
            assert_eq!(err.code, HANDSHAKE_FAILED);
        }
    }
}
