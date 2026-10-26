//! The startup sequence that runs behind the splash window.
//!
//! `App.tsx` used to call `load_stack` itself once the main window's React tree mounted, so the
//! manifest read and the checkout scan happened *after* the window was already on screen and the
//! app sat blank for however long that took. Running the same three steps here lets them happen
//! while the splash — which needs none of that data to render — is what the user is looking at.
//!
//! One level up, the main window's webview starts loading the instant that window is created —
//! hidden, before this thread runs — so the shell and its first-party apps are already booting
//! behind the splash. What they were *not* doing was being waited for: the splash handed off the
//! moment the disk work finished, and the first frame anyone saw was boot overlays resolving into
//! Home a beat later. So this waits for them too, folding their reports into the same bar.
//!
//! This module owns the whole lifecycle: the work, the wait on the apps, the progress reports, and
//! — via the watchdog at the bottom — the handoff happening even if the frontend never asks.

use crate::apps;
use crate::discovery;
use crate::error::AppError;
use crate::manifest::{self, Manifest};
use crate::state::AppState;
use crate::sync::MutexExt;
use serde::Serialize;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
// `Manager` puts `.state::<AppState>()` and `.get_webview_window(...)` on `AppHandle`; `Emitter`
// puts `.emit_to(...)` on it. Both are traits, so (as with `manifest.rs`'s `Manager` import) they
// only need to be in scope, never named again below.
use tauri::{AppHandle, Emitter, Manager};

/// How long the watchdog gives the frontend to call `finish_boot` on its own once boot reaches
/// `Ready` or `Failed`, before forcing the handoff.
const WATCHDOG_TIMEOUT: Duration = Duration::from_secs(10);

/// How long boot waits for every first-party app to report a painted frame before handing off
/// without whichever one is lagging.
///
/// Four seconds, chosen against `MIN_VISIBLE_MS` in `splash.html` (5s) rather than picked out of
/// the air. The three steps above finish in well under a second on any real machine, so even a
/// wait that runs the whole way out lands inside the floor the splash was going to hold for
/// anyway — a total timeout costs the user no startup time at all. What it costs is a window whose
/// first frame is a boot overlay, which is what this file used to hand them every single time.
///
/// Kept clear of `WATCHDOG_TIMEOUT` for the same reason `MIN_VISIBLE_MS` is: the watchdog is the
/// backstop for a frontend that never got its chance and must never race the normal path. It is
/// not even armed while this wait runs — it is armed from `Ready`, on the other side of it.
const APP_BOOT_TIMEOUT: Duration = Duration::from_secs(4);

/// Progress reported to the splash window, one value per `boot:status` event.
///
/// Internally tagged the same way `tool::ToolStatus` is: `#[serde(tag = ...)]` makes this
/// serialize as `{ "phase": "working", "step": 1, ... }` instead of the default
/// `{ "Working": { "step": 1, ... } }`, which is what turns into a clean discriminated union on
/// the TypeScript side (see `src/bindings.ts`).
///
/// `Ready` deliberately carries no data. The `StackSnapshot` it represents already went into
/// `AppState` via `store`; sending it again over the event would be a second, redundant copy of
/// the same JSON, and the frontend picks it up through `cached_stack` instead.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "phase", rename_all = "kebab-case")]
pub enum BootStatus {
    /// `rename_all = "camelCase"` here (as opposed to on the enum, which only governs the `phase`
    /// tag's own casing) is what would keep a multi-word field like `stepLabel` camelCase if one
    /// ever gets added — today's fields are single words so it is a no-op, but it matches the
    /// convention `StackSnapshot` and friends use and keeps this future-proof.
    #[serde(rename_all = "camelCase")]
    Working {
        step: u8,
        total: u8,
        label: String,
    },
    Ready,
    Failed {
        message: String,
    },
}

/// The steps that read the disk: locate the manifest, load it, scan the checkouts. Every one is
/// this thread's own work, and they run in order because each needs the one before it.
const SCAN_STEPS: u8 = 3;

/// The number of `Working` steps boot reports: the three above, plus one for each app it waits on.
///
/// A function rather than a constant now, because the second half of that sum comes from
/// `apps::REGISTRY` — which is the point. Adding a third app adds a segment to the splash's bar
/// and a report to wait for, with nothing here to remember to update.
///
/// The app steps are real work, not padding: each one is a first-party UI loading, running its
/// handshake, fetching what it draws and committing that to the DOM. The bar advances when one of
/// them reports having done it, never on a timer.
///
/// `pub(crate)` rather than private: `commands::boot_status` reuses it to build the same "nothing
/// reported yet" fallback shape this module would have produced for step 1 anyway.
pub(crate) fn total_steps() -> u8 {
    SCAN_STEPS + expected().len() as u8
}

/// Which apps this launch is actually waiting on.
///
/// Not the whole registry, which is what it used to be, and the difference is four seconds on most
/// launches. Boot waits for every app it expects to report `veistra/painted`, giving up after
/// `APP_BOOT_TIMEOUT` on any that do not — while every app was docked at startup, the roster and
/// what was on screen were the same list. No longer: a session restores the surfaces it had open,
/// and a first run opens Home alone. Waiting on the roster would hold the splash for the full
/// timeout on every launch where Files is not open, for a frame that was never mounted.
///
/// Set once by [`start`], from the layout already restored by the time it is called. The fallback
/// is the full roster, reached only if something asks before boot has begun.
static EXPECTED: OnceLock<Vec<(String, String)>> = OnceLock::new();

fn expected() -> Vec<(String, String)> {
    EXPECTED.get().cloned().unwrap_or_else(|| {
        apps::roster()
            .into_iter()
            .map(|(id, name)| (id.to_string(), name.to_string()))
            .collect()
    })
}

/// Where `painted` puts a report for the boot thread to pick up.
///
/// A `OnceLock` because there is exactly one boot per process: written once, by `start`, and read
/// from any thread afterwards without a lock of its own. The `Mutex` inside it is not optional —
/// `mpsc::Sender` is `Send` but not `Sync`, so it can be *moved* to another thread but not shared
/// with several at once, and a `static` is shared with all of them by definition.
///
/// A report that somehow arrived before `start` had run would be dropped. That ordering would
/// require an app frame to finish booting before the setup hook that creates the window it lives
/// in, and the timeout covers it even so.
static PAINTED: OnceLock<Mutex<Sender<String>>> = OnceLock::new();

/// Run the startup sequence and report progress to the splash window.
///
/// Called once from `lib.rs`'s `.setup()` hook, right after the splash window has been created
/// (it is `visible: true` in `tauri.conf.json`, so it is on screen the instant this fires).
///
/// This spawns a plain OS thread — `std::thread::spawn`, not `tauri::async_runtime::spawn`.
/// `locate`, `load` and `resolve` are synchronous functions doing blocking filesystem I/O with no
/// `.await` points. `tauri::async_runtime` is a small pool of worker threads for tasks that
/// cooperatively yield; blocking work on one parks the whole worker for the duration and starves
/// every async task queued behind it. A dedicated OS thread blocks only itself, exactly what
/// blocking work needs. (No `tokio` dependency either way, which keeps the dependency list
/// matching `Cargo.toml`.) The same reasoning covers what this thread does *after* the scan:
/// `await_apps` blocks on a channel for several seconds in the worst case, which on a shared
/// worker would starve everything behind it.
///
/// `waiting_for` is the apps that will actually mount this launch — see [`EXPECTED`]. `lib.rs`
/// reads it off the layout it has just restored, which is why `restore_session` runs before this.
pub fn start(app: AppHandle, waiting_for: Vec<(String, String)>) {
    let _ = EXPECTED.set(waiting_for);

    // Created here, on the caller's thread, rather than inside the closure below: the channel has
    // to exist before anything can report into it, and `start` is called from `setup` while the
    // windows that could report are still loading. Doing it inside the thread would leave a gap —
    // small, but one whose only symptom is a vanished report and a splash that waits out the
    // timeout for it.
    let (tx, reports) = mpsc::channel();
    let _ = PAINTED.set(Mutex::new(tx));

    std::thread::spawn(move || {
        let total = total_steps();

        emit(
            &app,
            BootStatus::Working {
                step: 1,
                total,
                label: "Locating manifest".into(),
            },
        );
        let path = match manifest::locate(&app) {
            Ok(path) => path,
            Err(err) => return fail(app, err),
        };

        emit(
            &app,
            BootStatus::Working {
                step: 2,
                total,
                label: "Reading manifest".into(),
            },
        );
        let manifest = match Manifest::load(&path) {
            Ok(manifest) => manifest,
            Err(err) => return fail(app, err),
        };

        emit(
            &app,
            BootStatus::Working {
                step: 3,
                total,
                label: "Scanning checkouts".into(),
            },
        );
        let snapshot = match discovery::resolve(&path, &manifest) {
            Ok(snapshot) => snapshot,
            Err(err) => return fail(app, err),
        };

        app.state::<AppState>().store(snapshot);
        await_apps(&app, reports, total);
        emit(&app, BootStatus::Ready);
        arm_watchdog(app);
    });
}

/// A first-party app's UI has drawn its first meaningful frame.
///
/// Called from `commands::app_painted`, which the shell reaches after an app frame sends
/// `veistra/painted` over transport B. Never called by an app for itself: the id is the one
/// `ToolWindow` resolved from the frame the message arrived on, not one the message claimed — the
/// same rule that makes a tool unable to answer for another tool.
///
/// Fire and forget, deliberately. Once boot has stopped waiting (every app reported, or the
/// timeout ran out) the receiver is dropped and a `send` here fails; there is nothing left to tell
/// and nothing worth telling it, so the error goes nowhere. A late report is not a bug — an app
/// that took six seconds still finishes loading, in a window that is already on screen.
pub fn painted(id: &str) {
    if let Some(reports) = PAINTED.get() {
        let _ = reports.lock_or_panic().send(id.to_string());
    }
}

/// Hold the splash until every first-party app has reported a painted frame, folding each report
/// into the progress bar as it lands.
///
/// Nothing is *started* here: the main window's webview has been loading since the window was
/// created (hidden, in `tauri.conf.json`), and the shell mounts one iframe per app as soon as it
/// has the list. All of them boot at once, in parallel with each other and with the scan above —
/// this only waits for the result, which is why waiting costs nothing already being spent.
///
/// The wait is bounded by `APP_BOOT_TIMEOUT`, and a straggler that trips it is reported and left
/// behind rather than followed. A splash window with no exit is the one failure here the user
/// cannot do anything about.
fn await_apps(app: &AppHandle, reports: Receiver<String>, total: u8) {
    let mut pending = expected();
    if pending.is_empty() {
        return;
    }

    let deadline = Instant::now() + APP_BOOT_TIMEOUT;
    emit(app, waiting_on(&pending, total));

    while !pending.is_empty() {
        // Measured fresh each time round rather than counted down: several reports can arrive in
        // one burst, and each `recv_timeout` gets what is left of the *original* deadline, not a
        // fresh copy of it.
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return give_up(&pending);
        }

        match reports.recv_timeout(left) {
            Ok(id) => {
                let Some(index) = pending.iter().position(|(app_id, _)| *app_id == id) else {
                    // An app reporting twice — React's StrictMode runs an effect twice in
                    // development — or a surface this is not waiting on at all. Neither is
                    // worth acting on and neither is worth failing over.
                    continue;
                };
                pending.remove(index);
                if !pending.is_empty() {
                    emit(app, waiting_on(&pending, total));
                }
            }
            // Timed out, or (impossible, since the sender lives in a `static` for the life of the
            // process) disconnected. Handled the same way and not unwrapped: a panic on this
            // thread would vanish silently and strand the splash on screen forever, which is the
            // one outcome worth writing code to prevent.
            Err(_) => return give_up(&pending),
        }
    }
}

/// The `Working` status for "these apps have not reported yet".
///
/// The step number is derived from what is left rather than counted up, so it cannot disagree with
/// `total`: with two apps outstanding of two, this is step 4 of 5 — the step *in progress* —
/// matching how the three scan steps above report themselves as they begin.
fn waiting_on(pending: &[(String, String)], total: u8) -> BootStatus {
    BootStatus::Working {
        step: total - pending.len() as u8 + 1,
        total,
        label: starting_label(pending),
    }
}

/// "Starting Home and Files", for whatever is still outstanding.
///
/// Named rather than counted because the names are the informative part — a splash stuck on one of
/// them says which app is the slow one, where "starting apps" for four seconds says only that
/// something is wrong.
fn starting_label(pending: &[(String, String)]) -> String {
    let names: Vec<&str> = pending.iter().map(|(_, name)| name.as_str()).collect();
    // `split_last` hands back the final element and everything before it, exactly the shape an
    // "a, b and c" list needs. `None` is unreachable — `await_apps` returns early on an empty
    // roster — and answers sensibly anyway rather than making this return an `Option` its one
    // caller would only unwrap.
    match names.split_last() {
        None => "Starting apps".to_string(),
        Some((last, [])) => format!("Starting {last}"),
        Some((last, rest)) => format!("Starting {} and {last}", rest.join(", ")),
    }
}

/// Stop waiting and say so. The splash goes on to `Ready` either way; this is
/// the only trace left that an app never answered, so it names which.
fn give_up(pending: &[(String, String)]) {
    let names: Vec<&str> = pending.iter().map(|(_, name)| name.as_str()).collect();
    crate::veistra_log!(
        "{} did not report a painted frame within {}s — showing the window anyway",
        names.join(", "),
        APP_BOOT_TIMEOUT.as_secs(),
    );
}

/// Report a failed boot and still arm the watchdog.
///
/// A missing manifest is the ordinary state of a machine nobody has cloned the stack onto yet, not
/// a bug — so this reports the error to the splash window and returns normally. It never panics: a
/// panic on this thread would just vanish (nothing joins its handle), leaving the splash frozen on
/// its last "Working" message forever with no explanation and no way forward.
///
/// It also skips the wait for the apps, on purpose. `Failed` puts a message and a "Continue
/// anyway" button on the splash and then waits on the person reading it, so there is no first
/// frame left to protect — and holding a window behind apps they cannot see only makes it slower.
fn fail(app: AppHandle, err: AppError) {
    emit(
        &app,
        BootStatus::Failed {
            message: err.to_string(),
        },
    );
    arm_watchdog(app);
}

/// Record a status update in `AppState` and send it to the splash window.
///
/// `emit` broadcasts to every window, but the main window's whole point is that it is still hidden
/// with nothing listening — and after `finish` closes the splash, any further emit would be
/// preaching to an empty room. `emit_to` targets one window by label, which also means a splash
/// listener never has to filter out events meant for someone else.
///
/// Emitting is fire-and-forget: the only way it fails is if the `splash` window has already gone
/// away (e.g. the watchdog raced this call), and at that point there is no one left to tell.
///
/// The write to `AppState` happens *before* the emit, and that ordering is load-bearing: it
/// guarantees any poll of `AppState::boot_status` landing after this call observes at least this
/// value, never something older. Flipping the order would open a window where the event has gone
/// out (so an already-subscribed listener sees it) but a poll racing it still reads the previous
/// status — trading the original "missed every event" bug for an equally real "stale poll" one.
fn emit(app: &AppHandle, status: BootStatus) {
    app.state::<AppState>().store_boot_status(status.clone());
    let _ = app.emit_to("splash", "boot:status", status);
}

/// Show every real window and close `splash`. Called from the `finish_boot` command (the
/// frontend's normal path) and from the watchdog below (the fallback path) — both can fire, so
/// this has to tolerate running twice.
///
/// Every window, not just `main`: a restored session can have several, and they are all created
/// hidden so none appears half-drawn while the splash is still up. Showing only `main` would leave
/// the rest invisible with no way to summon them.
///
/// `get_webview_window` hands back an `Option`, not a `Result`: "no window with this label" is a
/// fact about what exists, not an error. That makes idempotency free — the second call finds the
/// windows already shown (harmless) and `splash` already gone, with no "have I already run?" flag.
pub fn finish(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label == "splash" {
            continue;
        }
        let _ = window.show();
    }
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
}

/// Force the handoff if nobody has called `finish_boot` within `WATCHDOG_TIMEOUT` of boot reaching
/// `Ready` or `Failed`.
///
/// A splash window that never closes is a hang the user cannot recover from short of killing the
/// process — worth guarding even though the frontend's own listener normally beats this to it
/// comfortably. Another `std::thread::spawn` paired with a blocking `std::thread::sleep` is fine
/// here for the same reason it was in `start`: this thread has nothing else to do while it waits,
/// so there is no cooperative-scheduling downside to it blocking.
fn arm_watchdog(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(WATCHDOG_TIMEOUT);
        finish(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The helpers take owned pairs, because what boot waits on is now derived from the restored
    /// layout rather than borrowed from the `&'static` registry. Tests still read better as string
    /// literals, so they are converted here rather than at every call.
    fn pairs(from: &[(&str, &str)]) -> Vec<(String, String)> {
        from.iter()
            .map(|(id, name)| ((*id).to_string(), (*name).to_string()))
            .collect()
    }

    /// The label is the only thing on the splash that reads as a sentence, and it is built from a
    /// list whose length is whatever `apps::REGISTRY` says. Both list forms are worth pinning:
    /// today's registry produces the second and a third app would silently produce the third.
    #[test]
    fn the_label_names_what_is_left() {
        assert_eq!(starting_label(&pairs(&[("home", "Home")])), "Starting Home");
        assert_eq!(
            starting_label(&pairs(&[("home", "Home"), ("files", "Files")])),
            "Starting Home and Files"
        );
        assert_eq!(
            starting_label(&pairs(&[("a", "A"), ("b", "B"), ("c", "C")])),
            "Starting A, B and C"
        );
    }

    /// The bar must show the step *in progress*, matching how the scan steps report themselves:
    /// with both apps outstanding of five, the three scans are done and the fourth is under way.
    #[test]
    fn the_step_counts_the_apps_already_heard_from() {
        let both = pairs(&[("home", "Home"), ("files", "Files")]);
        let BootStatus::Working { step, total, .. } = waiting_on(&both, 5) else {
            panic!("waiting on an app is a Working status");
        };
        assert_eq!((step, total), (4, 5));

        let BootStatus::Working { step, .. } = waiting_on(&both[1..], 5) else {
            panic!("waiting on an app is a Working status");
        };
        assert_eq!(step, 5, "one report in, one app left to hear from");
    }
}
