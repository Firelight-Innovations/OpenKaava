//! Where the person's focus is, as the shell last reported it.
//!
//! Focus lives in the DOM, which the backend cannot see, so each window's shell
//! tells us when it moves (`report_focus`, debounced on the webview side). This
//! is the one place the answer is kept: the workspace server's `focus` tool and
//! its `kaava://workspace/focus` resource both read it, and a change here is what
//! wakes a subscribed agent.
//!
//! Two small pieces, both pure so they can be tested without an `AppHandle`:
//! [`FocusState`] decides whether a report is news, and [`Coalescer`] decides
//! whether the notification for it should be sent now or folded into one that is
//! already on its way.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// What one window's shell says about focus.
///
/// `window` is the window label. `focus_in` is `app`, `terminal`, `shell` or
/// `nothing`, the same four words the page-side probe used. `instance` is the
/// surface that holds DOM focus, `pane` the pane the shell treats as active, and
/// `cluster` the cluster on screen; each is `None` when there is no such thing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FocusReport {
    pub window: String,
    pub window_has_focus: bool,
    pub focus_in: String,
    pub instance: Option<String>,
    pub pane: Option<String>,
    pub cluster: Option<String>,
}

/// The latest report from every window, keyed by window label.
///
/// A `std::sync::Mutex`, held only for the duration of a map operation and never
/// across an `.await`, like [`Registry`](super::Registry): every method copies
/// what it returns and lets the guard go.
#[derive(Default)]
pub struct FocusState {
    reports: Mutex<BTreeMap<String, FocusReport>>,
    /// Whether a notification for the latest change is already on its way.
    pub burst: Coalescer,
}

impl FocusState {
    /// Record a report. Returns whether it differs from the one already held for
    /// that window, which is the only case anybody downstream needs to hear about.
    ///
    /// `BTreeMap::insert` hands back the value it replaced, so "was there one,
    /// and was it equal" is a single lookup rather than a read followed by a
    /// write.
    pub fn update(&self, report: FocusReport) -> bool {
        let Ok(mut reports) = self.reports.lock() else {
            return false;
        };
        let previous = reports.insert(report.window.clone(), report.clone());
        previous.as_ref() != Some(&report)
    }

    /// Forget a window, for when it closes. Returns whether anything was held.
    pub fn forget(&self, window: &str) -> bool {
        self.reports
            .lock()
            .map(|mut reports| reports.remove(window).is_some())
            .unwrap_or(false)
    }

    /// The report for one window, if it has sent one.
    pub fn report_for(&self, window: &str) -> Option<FocusReport> {
        self.reports.lock().ok()?.get(window).cloned()
    }
}

/// Folds a burst of changes into one notification.
///
/// Moving focus from one OpenKaava window to another produces two reports a few
/// milliseconds apart (the old window blurs, the new one gains focus), and an
/// agent only needs to hear about the end state. The first change arms the
/// coalescer and the caller sleeps briefly before sending; changes that land
/// during the sleep see it already armed and send nothing, because the read that
/// follows the notification will pick them up anyway.
///
/// An `AtomicBool` rather than a mutex: it is one flag, and `swap` is the atomic
/// "set it and tell me what it was" the whole idea needs.
#[derive(Default)]
pub struct Coalescer {
    armed: AtomicBool,
}

impl Coalescer {
    /// Returns `true` when this call armed it, meaning the caller owns sending
    /// the notification and must [`Coalescer::fire`] first.
    pub fn arm(&self) -> bool {
        !self.armed.swap(true, Ordering::AcqRel)
    }

    /// Disarm, so the next change starts a new burst. Call just before sending,
    /// so a change that lands during the send arms a fresh notification instead
    /// of being swallowed.
    pub fn fire(&self) {
        self.armed.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(window: &str, instance: Option<&str>) -> FocusReport {
        FocusReport {
            window: window.to_string(),
            window_has_focus: true,
            focus_in: "app".to_string(),
            instance: instance.map(str::to_owned),
            pane: Some("pane-1".to_string()),
            cluster: Some("cluster-1".to_string()),
        }
    }

    #[test]
    fn the_first_report_is_a_change() {
        let state = FocusState::default();
        assert!(state.update(report("main", Some("canvas-1"))));
    }

    #[test]
    fn repeating_the_same_focus_is_not_a_change() {
        let state = FocusState::default();
        assert!(state.update(report("main", Some("canvas-1"))));
        assert!(!state.update(report("main", Some("canvas-1"))));
        assert!(!state.update(report("main", Some("canvas-1"))));
    }

    #[test]
    fn moving_to_another_instance_is_a_change() {
        let state = FocusState::default();
        state.update(report("main", Some("canvas-1")));
        assert!(state.update(report("main", Some("canvas-2"))));
        assert_eq!(
            state.report_for("main").and_then(|r| r.instance),
            Some("canvas-2".to_string())
        );
    }

    /// Pane, cluster and window focus each count as news on their own.
    #[test]
    fn every_field_counts_toward_a_change() {
        let state = FocusState::default();
        let base = report("main", Some("canvas-1"));
        state.update(base.clone());

        let mut other_pane = base;
        other_pane.pane = Some("pane-2".to_string());
        assert!(state.update(other_pane.clone()));

        let mut other_cluster = other_pane;
        other_cluster.cluster = Some("cluster-2".to_string());
        assert!(state.update(other_cluster.clone()));

        let mut blurred = other_cluster;
        blurred.window_has_focus = false;
        assert!(state.update(blurred));
    }

    #[test]
    fn windows_are_tracked_independently() {
        let state = FocusState::default();
        assert!(state.update(report("main", Some("canvas-1"))));
        assert!(state.update(report("window-2", Some("canvas-1"))));
        assert!(state.report_for("main").is_some());
        assert!(state.report_for("window-2").is_some());
        assert!(!state.update(report("main", Some("canvas-1"))));
    }

    #[test]
    fn a_forgotten_window_is_news_again_when_it_returns() {
        let state = FocusState::default();
        state.update(report("main", Some("canvas-1")));
        assert!(state.forget("main"));
        assert!(!state.forget("main"));
        assert!(state.report_for("main").is_none());
        assert!(state.update(report("main", Some("canvas-1"))));
    }

    #[test]
    fn a_burst_is_one_notification() {
        let coalescer = Coalescer::default();
        assert!(coalescer.arm(), "the first change owns the send");
        assert!(!coalescer.arm(), "a change during the wait adds nothing");
        assert!(!coalescer.arm());

        coalescer.fire();
        assert!(
            coalescer.arm(),
            "after the send, the next change starts afresh"
        );
    }

    #[test]
    fn a_report_deserialises_from_the_shell_camel_case() {
        let parsed: FocusReport = serde_json::from_value(serde_json::json!({
            "window": "main",
            "windowHasFocus": true,
            "focusIn": "terminal",
            "instance": "term-1",
        }))
        .expect("the shell payload parses");
        assert_eq!(parsed.focus_in, "terminal");
        assert_eq!(parsed.pane, None);
    }
}
