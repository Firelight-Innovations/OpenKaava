//! The wake state machine `OPENKAAVA-PLANE-DESIGN.md` §3.3 asks for, mirroring
//! `infra/common/kaava-wake/kaava_wake.py`'s state handling in Rust:
//!
//! 1. Read the instance's status. If it is already `RUNNING`, skip to step 3.
//! 2. If `TERMINATED` (or the rarer `STOPPED`), start it, then poll status
//!    every 3 s until `RUNNING` (timeout 120 s). `STOPPING`/`SUSPENDING` are
//!    waited out rather than acted on — Compute Engine refuses a start while
//!    either is in progress.
//! 3. Poll the health check every 3 s until it passes (timeout 240 s).
//!
//! [`wake`] is a pure function over injected [`Probes`] and [`Clock`], so it
//! is unit-tested below without a network, a real timer, or `gcloud` on
//! `PATH` — the same shape the Python reference takes with its module-level
//! `now`/`sleep` swap. `apps/projects.rs` is the one caller that supplies the
//! real versions and turns `Progress` into "Starting Plane… Ns" for the UI.

use std::time::Duration;

/// design §3.3: timeouts and poll interval.
const POLL_SECONDS: f64 = 3.0;
const RUNNING_TIMEOUT_SECONDS: f64 = 120.0;
const HEALTH_TIMEOUT_SECONDS: f64 = 240.0;

/// What step 3 asks: every health path answered 200 (`Ok`), or the detail of
/// whichever one did not (`Err`) — a refused connection or an HTTP 502 counts
/// as "not yet", per the handoff, not as a hard failure.
pub type HealthCheck<'a> = dyn Fn() -> Result<(), String> + 'a;

/// The three Google/Plane calls [`wake`] drives. Each is a closure so a test
/// can answer instance status and health without touching a network — the
/// same role `Instance.status`/`.start`/`wait_healthy`'s per-URL check play in
/// the Python reference.
pub struct Probes<'a> {
    /// Compute Engine's `status` field: `RUNNING`, `STOPPING`, `TERMINATED`, …
    pub status: &'a dyn Fn() -> Result<String, String>,
    /// `instances.start`. Called at most once per [`wake`] unless the VM was
    /// found `STOPPING` and had to be asked again after it finished.
    pub start: &'a dyn Fn() -> Result<(), String>,
    pub health: &'a HealthCheck<'a>,
}

/// A monotonic clock and a sleep, both injected. `now` returns seconds since
/// some fixed point — the wall value never matters, only the deltas — which
/// is what lets a test advance time without a real `Duration::from_secs(120)`
/// wait.
pub struct Clock<'a> {
    pub now: &'a dyn Fn() -> f64,
    pub sleep: &'a dyn Fn(Duration),
}

/// What [`wake`] reports as it goes, for a "Starting Plane… Ns" label.
#[derive(Debug, Clone, PartialEq)]
pub enum Progress {
    /// The instance's status, as last read.
    Status(String),
    /// `instances.start` was just called.
    Starting,
    /// Still waiting on the health check; carries the last failing detail.
    WaitingHealthy(String),
}

/// Why [`wake`] did not reach `Ok`.
#[derive(Debug, Clone, PartialEq)]
pub enum WakeError {
    /// A probe returned `Err`.
    Probe(String),
    /// The Cancel button was pressed.
    Cancelled,
    /// [`RUNNING_TIMEOUT_SECONDS`] passed with no `RUNNING` state.
    NotRunning { last_status: String },
    /// [`HEALTH_TIMEOUT_SECONDS`] passed with the health check still failing.
    Unhealthy { detail: String },
}

/// Bring one service up and healthy. Returns the seconds it took.
///
/// `should_cancel` is polled between every wait, so a press of Cancel stops
/// the flow within one [`POLL_SECONDS`] tick rather than only between the two
/// phases.
pub fn wake(
    probes: &Probes,
    clock: &Clock,
    mut on_progress: impl FnMut(Progress),
    should_cancel: &dyn Fn() -> bool,
) -> Result<f64, WakeError> {
    let started = (clock.now)();
    wait_running(probes, clock, &mut on_progress, should_cancel, started)?;
    wait_healthy(probes, clock, &mut on_progress, should_cancel, started)?;
    Ok((clock.now)() - started)
}

fn check_cancel(should_cancel: &dyn Fn() -> bool) -> Result<(), WakeError> {
    if should_cancel() {
        Err(WakeError::Cancelled)
    } else {
        Ok(())
    }
}

fn wait_running(
    probes: &Probes,
    clock: &Clock,
    on_progress: &mut impl FnMut(Progress),
    should_cancel: &dyn Fn() -> bool,
    started: f64,
) -> Result<(), WakeError> {
    let deadline = started + RUNNING_TIMEOUT_SECONDS;
    let mut asked = false;
    loop {
        let status = (probes.status)().map_err(WakeError::Probe)?;
        on_progress(Progress::Status(status.clone()));
        if status == "RUNNING" {
            return Ok(());
        }
        if !asked && matches!(status.as_str(), "TERMINATED" | "STOPPED") {
            (probes.start)().map_err(WakeError::Probe)?;
            on_progress(Progress::Starting);
            asked = true;
        }
        // STOPPING/SUSPENDING (and any other transitional state) are waited
        // out rather than acted on, matching the Python reference: Compute
        // Engine refuses `start` mid-transition, so asking again would only
        // trade one wait for an error that means the same thing.
        if (clock.now)() >= deadline {
            return Err(WakeError::NotRunning {
                last_status: status,
            });
        }
        // Checked here, right before the sleep, rather than at the top of
        // the loop: a status that already reads `RUNNING` returns above
        // without ever waiting, and should not spend should_cancel's answer
        // on a wait that never happened — that answer belongs to whichever
        // loop (this one's next lap, or wait_healthy's first) actually polls
        // again.
        check_cancel(should_cancel)?;
        (clock.sleep)(Duration::from_secs_f64(POLL_SECONDS));
    }
}

fn wait_healthy(
    probes: &Probes,
    clock: &Clock,
    on_progress: &mut impl FnMut(Progress),
    should_cancel: &dyn Fn() -> bool,
    started: f64,
) -> Result<(), WakeError> {
    let deadline = started + RUNNING_TIMEOUT_SECONDS + HEALTH_TIMEOUT_SECONDS;
    loop {
        check_cancel(should_cancel)?;
        match (probes.health)() {
            Ok(()) => return Ok(()),
            Err(detail) => {
                on_progress(Progress::WaitingHealthy(detail.clone()));
                if (clock.now)() >= deadline {
                    return Err(WakeError::Unhealthy { detail });
                }
                (clock.sleep)(Duration::from_secs_f64(POLL_SECONDS));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// A clock that advances by [`POLL_SECONDS`] on every `sleep` rather than
    /// waiting for one, so a 240 s timeout test runs in a moment.
    ///
    /// A macro rather than a function: the two closures below borrow
    /// `$elapsed`, and `Clock` holds them by reference, so they have to live
    /// as long as the `Clock` a test builds from them. Returned out of an
    /// ordinary function they would be temporaries dropped at that
    /// function's own `}` — a lifetime error, not a borrow-checker false
    /// positive — where expanding inline puts them in the *test's* `let`
    /// statement, which is exactly where Rust's temporary-lifetime-extension
    /// rule keeps a `let`'s own temporaries alive for the binding's scope.
    macro_rules! fake_clock {
        ($elapsed:expr) => {
            Clock {
                now: &|| $elapsed.get(),
                sleep: &|d| $elapsed.set($elapsed.get() + d.as_secs_f64()),
            }
        };
    }

    #[test]
    fn an_already_running_instance_skips_straight_to_health() {
        let elapsed = Cell::new(0.0);
        let clock = fake_clock!(elapsed);
        let started = Cell::new(false);
        let probes = Probes {
            status: &|| Ok("RUNNING".to_string()),
            start: &|| {
                started.set(true);
                Ok(())
            },
            health: &|| Ok(()),
        };
        let seconds = wake(&probes, &clock, |_| {}, &|| false).unwrap();
        assert_eq!(seconds, 0.0);
        assert!(!started.get(), "a running instance is never asked to start");
    }

    #[test]
    fn a_terminated_instance_is_started_exactly_once() {
        let elapsed = Cell::new(0.0);
        let clock = fake_clock!(elapsed);
        let polls = Cell::new(0);
        let starts = Cell::new(0);
        let probes = Probes {
            status: &|| {
                let n = polls.get();
                polls.set(n + 1);
                Ok(if n < 2 { "TERMINATED" } else { "RUNNING" }.to_string())
            },
            start: &|| {
                starts.set(starts.get() + 1);
                Ok(())
            },
            health: &|| Ok(()),
        };
        wake(&probes, &clock, |_| {}, &|| false).unwrap();
        assert_eq!(starts.get(), 1);
    }

    #[test]
    fn stopping_is_waited_out_rather_than_started() {
        let elapsed = Cell::new(0.0);
        let clock = fake_clock!(elapsed);
        let polls = Cell::new(0);
        let starts = Cell::new(0);
        let probes = Probes {
            status: &|| {
                let n = polls.get();
                polls.set(n + 1);
                Ok(match n {
                    0 => "STOPPING",
                    1 => "TERMINATED",
                    _ => "RUNNING",
                }
                .to_string())
            },
            start: &|| {
                starts.set(starts.get() + 1);
                Ok(())
            },
            health: &|| Ok(()),
        };
        wake(&probes, &clock, |_| {}, &|| false).unwrap();
        assert_eq!(starts.get(), 1, "start is called once TERMINATED is seen");
    }

    #[test]
    fn a_health_check_that_keeps_failing_times_out() {
        let elapsed = Cell::new(0.0);
        let clock = fake_clock!(elapsed);
        let probes = Probes {
            status: &|| Ok("RUNNING".to_string()),
            start: &|| Ok(()),
            health: &|| Err("connection refused".to_string()),
        };
        let err = wake(&probes, &clock, |_| {}, &|| false).unwrap_err();
        assert_eq!(
            err,
            WakeError::Unhealthy {
                detail: "connection refused".to_string()
            }
        );
    }

    #[test]
    fn a_health_check_that_eventually_passes_reports_progress_first() {
        let elapsed = Cell::new(0.0);
        let clock = fake_clock!(elapsed);
        let attempts = Cell::new(0);
        let probes = Probes {
            status: &|| Ok("RUNNING".to_string()),
            start: &|| Ok(()),
            health: &|| {
                let n = attempts.get();
                attempts.set(n + 1);
                if n < 2 {
                    Err("HTTP 502".to_string())
                } else {
                    Ok(())
                }
            },
        };
        let progress = RefCell::new(Vec::new());
        wake(&probes, &clock, |p| progress.borrow_mut().push(p), &|| {
            false
        })
        .unwrap();
        assert!(progress
            .borrow()
            .iter()
            .any(|p| *p == Progress::WaitingHealthy("HTTP 502".to_string())));
    }

    #[test]
    fn cancelling_stops_the_flow_with_no_further_probes() {
        let elapsed = Cell::new(0.0);
        let clock = fake_clock!(elapsed);
        let health_calls = Cell::new(0);
        let probes = Probes {
            status: &|| Ok("RUNNING".to_string()),
            start: &|| Ok(()),
            health: &|| {
                health_calls.set(health_calls.get() + 1);
                Err("waiting".to_string())
            },
        };
        let asked = Cell::new(false);
        let err = wake(&probes, &clock, |_| {}, &|| {
            let already = asked.get();
            asked.set(true);
            already
        })
        .unwrap_err();
        assert_eq!(err, WakeError::Cancelled);
        assert_eq!(
            health_calls.get(),
            1,
            "cancel is checked before the next poll"
        );
    }

    #[test]
    fn an_instance_that_never_reaches_running_times_out_with_its_last_status() {
        let elapsed = Cell::new(0.0);
        let clock = fake_clock!(elapsed);
        let probes = Probes {
            status: &|| Ok("STAGING".to_string()),
            start: &|| Ok(()),
            health: &|| Ok(()),
        };
        let err = wake(&probes, &clock, |_| {}, &|| false).unwrap_err();
        assert_eq!(
            err,
            WakeError::NotRunning {
                last_status: "STAGING".to_string()
            }
        );
    }

    #[test]
    fn a_probe_failure_surfaces_instead_of_looping_forever() {
        let elapsed = Cell::new(0.0);
        let clock = fake_clock!(elapsed);
        let probes = Probes {
            status: &|| Err("denied".to_string()),
            start: &|| Ok(()),
            health: &|| Ok(()),
        };
        let err = wake(&probes, &clock, |_| {}, &|| false).unwrap_err();
        assert_eq!(err, WakeError::Probe("denied".to_string()));
    }
}
