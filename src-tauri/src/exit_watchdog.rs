//! A deadline on shutdown, so a stuck exit cannot leave a process nobody can see.
//!
//! OpenKaava is single-instance: a second launch hands its arguments to the
//! process already running and waits for it to answer. A process that has
//! hidden its windows and then stalled on the way out still holds that claim,
//! so every later launch waits on it forever and nothing appears on screen.
//! The only cure is Task Manager, and nothing tells the person so.
//!
//! [`arm`] starts the clock when an exit begins. If the process is still alive
//! [`GRACE`] later, it is ended from a thread that does not depend on the main
//! one. Rejected: bounding each cleanup step instead. Every step in
//! `RunEvent::Exit` already has its own bound, and the stall this guards
//! against is the one nobody predicted.

use std::sync::Once;
use std::time::Duration;

/// How long an exit may take before it is forced.
///
/// Longer than the cleanup it races: stopping a Blender job and stopping a
/// Godot run each wait up to three seconds for the child to go.
pub const GRACE: Duration = Duration::from_secs(10);

static ARMED: Once = Once::new();

/// Start the deadline. Safe to call from every path that begins an exit; only
/// the first call counts.
///
/// Forcing the exit skips whatever cleanup had not run yet, so a plugin core or
/// a `gcloud` tunnel can outlive it. That is the lesser failure: an orphaned
/// child is visible in a process list under its own name, and it does not stop
/// OpenKaava from starting again.
pub fn arm() {
    ARMED.call_once(|| {
        after(GRACE, || {
            eprintln!("kaava: exit did not finish within {GRACE:?}; forcing it");
            std::process::exit(0);
        });
    });
}

/// Run `then` on its own thread once `grace` has passed.
///
/// A plain thread and a blocking sleep rather than a task on the async
/// runtime: the runtime is one of the things being torn down while this waits.
fn after(grace: Duration, then: impl FnOnce() + Send + 'static) {
    std::thread::spawn(move || {
        std::thread::sleep(grace);
        then();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn fires_once_the_grace_has_passed_and_not_before() {
        let (tx, rx) = mpsc::channel();
        after(Duration::from_millis(200), move || {
            let _ = tx.send(());
        });

        assert!(
            rx.recv_timeout(Duration::from_millis(50)).is_err(),
            "nothing fires while the exit still has time"
        );
        assert!(
            rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "and it does fire once the time is up"
        );
    }
}
