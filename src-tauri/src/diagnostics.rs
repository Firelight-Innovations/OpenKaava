//! What went wrong, kept where something can still be asked about it.
//!
//! Every failure path in this crate writes a line to stderr and moves on, and a
//! release build has no console attached to receive it. This is the ring buffer
//! that keeps those lines in memory instead, readable afterwards — by the
//! settings UI, or by an agent over `mcp::servers::debug`.
//!
//! A process-wide static rather than Tauri managed state, and bounded rather
//! than growing. Both are argued in `docs/design-notes/agent-debugging.md`.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// How many records are kept before the oldest starts falling off.
///
/// Sized for "what just happened", not for an audit trail. At roughly 120 bytes
/// a record this is under 64 KB held for the life of the process, which is a
/// price worth paying unconditionally; anything wanting real history wants a log
/// file, and that is a different feature with a different set of questions
/// attached.
const CAPACITY: usize = 500;

/// Which half of Veistra a record came from.
///
/// An enum rather than a free string because a reader's first cut is almost
/// always this one — a Rust store failing to write and an app's promise
/// rejecting are different investigations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    /// Rust. Written by [`veistra_log!`](crate::veistra_log).
    Backend,
    /// The webview: an uncaught error, a rejected promise, or a `console.error`.
    Frontend,
}

/// One thing that went wrong.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// Monotonic across the process, starting at 1.
    ///
    /// This is what makes polling work: a reader keeps the highest `seq` it has
    /// seen and asks for what came after, rather than re-reading the buffer and
    /// diffing it. Never reused, and never reset by records falling off the
    /// back, so a gap in the sequence is itself a signal that some were dropped.
    pub seq: u64,
    /// Milliseconds since the Unix epoch.
    pub at: u64,
    pub origin: Origin,
    pub message: String,
}

/// A read of the buffer, and what the buffer knows it is missing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub records: Vec<Record>,
    /// How many records have fallen off the back since the process started.
    ///
    /// Non-zero means this history has a hole in it, and a reader that cares
    /// about completeness should say so rather than presenting what it got as
    /// the whole story.
    pub dropped: u64,
    /// The highest `seq` issued so far, whether or not it is still held.
    ///
    /// A poller passes this back as `after` next time. Reading it from the
    /// counter rather than from the last record means an empty result still
    /// advances the cursor correctly.
    pub latest_seq: u64,
}

#[derive(Default)]
struct Inner {
    records: VecDeque<Record>,
    next_seq: u64,
    dropped: u64,
}

/// The ring buffer. Reach it through [`diagnostics`].
#[derive(Default)]
pub struct Diagnostics {
    inner: Mutex<Inner>,
}

impl Diagnostics {
    /// Add a record. Never fails, and never blocks on anything but its own lock.
    ///
    /// A poisoned lock is dropped on the floor rather than propagated. This is
    /// the one place in the crate where that is unambiguously right: every
    /// caller is already on a failure path, and a diagnostics buffer that can
    /// panic turns "a write failed" into "the process died reporting that a
    /// write failed".
    pub fn record(&self, origin: Origin, message: impl Into<String>) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };

        inner.next_seq += 1;
        let record = Record {
            seq: inner.next_seq,
            at: now_ms(),
            origin,
            message: message.into(),
        };

        inner.records.push_back(record);
        while inner.records.len() > CAPACITY {
            inner.records.pop_front();
            inner.dropped += 1;
        }
    }

    /// Records newer than `after`, oldest first, capped at `limit`.
    ///
    /// `after` is a `seq`, not an index or a timestamp, so it stays correct
    /// across records falling off the back. Passing `None` reads from the start
    /// of what is held.
    ///
    /// When `limit` cuts the result short it keeps the **oldest** matches rather
    /// than the newest, so that a caller walking forward with the returned
    /// `seq`s makes progress instead of skipping the middle of a burst.
    pub fn since(&self, after: Option<u64>, limit: usize) -> Snapshot {
        let Ok(inner) = self.inner.lock() else {
            return Snapshot {
                records: Vec::new(),
                dropped: 0,
                latest_seq: 0,
            };
        };

        let floor = after.unwrap_or(0);
        let records = inner
            .records
            .iter()
            .filter(|r| r.seq > floor)
            .take(limit)
            .cloned()
            .collect();

        Snapshot {
            records,
            dropped: inner.dropped,
            latest_seq: inner.next_seq,
        }
    }
}

/// The process-wide buffer.
///
/// `OnceLock` rather than a plain `static` because `VecDeque::new` is not a
/// `const fn` on this crate's toolchain, and rather than `LazyLock` to leave the
/// minimum toolchain where it already is.
pub fn diagnostics() -> &'static Diagnostics {
    static BUFFER: OnceLock<Diagnostics> = OnceLock::new();
    BUFFER.get_or_init(Diagnostics::default)
}

/// A clock failure reads as the epoch rather than panicking.
///
/// `SystemTime` is only before the epoch on a machine whose clock is badly
/// wrong, and a wrong timestamp on a diagnostic record is worth strictly less
/// than the record itself.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The longest message kept, in bytes.
///
/// Aimed at the frontend, which is where an unbounded one actually arrives: a
/// rejected promise carrying a stack trace is routinely several kilobytes, and
/// twenty of those would be most of the buffer spent on one incident. The head
/// of a stack names the throw site, which is the part worth keeping.
const MAX_MESSAGE: usize = 2000;

/// Cut to [`MAX_MESSAGE`], on a character boundary, saying that it was cut.
///
/// `floor_char_boundary` is still unstable, so the boundary walk is done by
/// hand. Truncating mid-codepoint would panic on the slice, which would turn
/// reporting an error into causing one.
fn clamp(message: String) -> String {
    if message.len() <= MAX_MESSAGE {
        return message;
    }

    let mut cut = MAX_MESSAGE;
    while cut > 0 && !message.is_char_boundary(cut) {
        cut -= 1;
    }

    format!("{}… [truncated]", &message[..cut])
}

/// Record something the webview caught: an uncaught error, a rejected promise,
/// or a `console.error`.
///
/// Deliberately infallible and deliberately silent. The frontend calls this from
/// inside its own error handlers, and a command that could reject would mean an
/// error report whose failure raised another error to report.
#[tauri::command]
pub fn report_frontend_error(message: String) {
    diagnostics().record(Origin::Frontend, clamp(message));
}

/// Report a backend failure: to stderr as before, and to the ring buffer.
///
/// Takes the same arguments as `eprintln!` **minus the `veistra: ` prefix**, which
/// it adds. Every call site this replaced spelled that prefix out, and one that
/// forgot it was indistinguishable from a stray print by a dependency.
///
/// The stderr half is kept rather than replaced. A debug build with a console
/// attached is still the fastest way to watch Veistra fail, and this is meant to
/// add a second reader, not to take the first one away.
#[macro_export]
macro_rules! veistra_log {
    ($($arg:tt)*) => {{
        let message = format!($($arg)*);
        eprintln!("veistra: {message}");
        $crate::diagnostics::diagnostics().record($crate::diagnostics::Origin::Backend, message);
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh buffer per test. The process-wide one is shared with every other
    /// test in the binary, so asserting on its contents would be a race.
    fn buffer() -> Diagnostics {
        Diagnostics::default()
    }

    #[test]
    fn a_record_comes_back_with_what_it_was_given() {
        let log = buffer();
        log.record(Origin::Backend, "could not write layout.json");

        let read = log.since(None, 10);
        assert_eq!(read.records.len(), 1);
        assert_eq!(read.records[0].message, "could not write layout.json");
        assert_eq!(read.records[0].origin, Origin::Backend);
        assert_eq!(read.records[0].seq, 1);
        assert_eq!(read.dropped, 0);
    }

    #[test]
    fn sequence_numbers_start_at_one_and_increase() {
        let log = buffer();
        for i in 0..5 {
            log.record(Origin::Backend, format!("failure {i}"));
        }

        let seqs: Vec<u64> = log.since(None, 10).records.iter().map(|r| r.seq).collect();
        assert_eq!(seqs, vec![1, 2, 3, 4, 5]);
    }

    /// The polling contract: hand back the cursor, get only what is new.
    #[test]
    fn after_a_cursor_returns_only_later_records() {
        let log = buffer();
        log.record(Origin::Backend, "first");
        log.record(Origin::Backend, "second");

        let read = log.since(Some(1), 10);
        assert_eq!(read.records.len(), 1);
        assert_eq!(read.records[0].message, "second");
        assert_eq!(read.latest_seq, 2);
    }

    /// An empty read still advances the cursor, which is why `latest_seq` comes
    /// from the counter rather than from the last record returned.
    #[test]
    fn an_empty_read_still_reports_the_latest_sequence() {
        let log = buffer();
        log.record(Origin::Backend, "only");

        let read = log.since(Some(1), 10);
        assert!(read.records.is_empty());
        assert_eq!(read.latest_seq, 1);
    }

    #[test]
    fn the_buffer_drops_the_oldest_and_counts_what_it_dropped() {
        let log = buffer();
        for i in 0..(CAPACITY + 10) {
            log.record(Origin::Backend, format!("failure {i}"));
        }

        let read = log.since(None, CAPACITY * 2);
        assert_eq!(read.records.len(), CAPACITY);
        assert_eq!(read.dropped, 10);
        assert_eq!(
            read.records[0].message, "failure 10",
            "the ten oldest should be the ones gone"
        );
        assert_eq!(read.latest_seq, (CAPACITY + 10) as u64);
    }

    /// Keeping the newest under a limit would let a caller walking the cursor
    /// forward skip everything between its cursor and the tail.
    #[test]
    fn a_limit_keeps_the_oldest_matches_so_a_poller_makes_progress() {
        let log = buffer();
        for i in 0..10 {
            log.record(Origin::Backend, format!("failure {i}"));
        }

        let read = log.since(None, 3);
        let messages: Vec<&str> = read.records.iter().map(|r| r.message.as_str()).collect();
        assert_eq!(messages, vec!["failure 0", "failure 1", "failure 2"]);
    }

    #[test]
    fn origin_survives_the_round_trip() {
        let log = buffer();
        log.record(Origin::Frontend, "Uncaught TypeError");
        log.record(Origin::Backend, "could not bind");

        let read = log.since(None, 10);
        assert_eq!(read.records[0].origin, Origin::Frontend);
        assert_eq!(read.records[1].origin, Origin::Backend);
    }

    /// A reader parses these as JSON, so the field names are part of the
    /// contract rather than an implementation detail.
    #[test]
    fn a_snapshot_serializes_with_camel_case_field_names() {
        let log = buffer();
        log.record(Origin::Frontend, "boom");

        let json = serde_json::to_value(log.since(None, 10)).expect("a snapshot serializes");
        assert_eq!(json["latestSeq"], 1);
        assert_eq!(json["dropped"], 0);
        assert_eq!(json["records"][0]["origin"], "frontend");
        assert_eq!(json["records"][0]["message"], "boom");
        assert!(json["records"][0]["at"].is_u64());
    }

    #[test]
    fn the_process_wide_buffer_is_one_buffer() {
        assert!(std::ptr::eq(diagnostics(), diagnostics()));
    }

    #[test]
    fn a_short_message_is_left_exactly_as_it_was() {
        let message = "Uncaught TypeError: x is not a function".to_string();
        assert_eq!(clamp(message.clone()), message);
    }

    #[test]
    fn a_long_message_is_cut_and_says_so() {
        let clamped = clamp("x".repeat(MAX_MESSAGE + 500));
        assert!(clamped.starts_with(&"x".repeat(MAX_MESSAGE)));
        assert!(clamped.ends_with("… [truncated]"));
    }

    /// Slicing mid-codepoint would panic, which would turn reporting an error
    /// into causing one. The em-dash straddles the cut here by construction.
    #[test]
    fn cutting_never_splits_a_character() {
        let mut message = "a".repeat(MAX_MESSAGE - 1);
        message.push('—');
        message.push_str(&"b".repeat(100));

        let clamped = clamp(message);
        assert!(clamped.starts_with(&"a".repeat(MAX_MESSAGE - 1)));
        assert!(clamped.ends_with("… [truncated]"));
    }
}
