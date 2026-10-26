//! Marker-token scanning and code-to-design reconciliation for Schematify
//! (`SCHEMATIFY-PRD.md` section 9). This crate is both halves of the
//! `veistra reconcile` command (`src/bin/veistra.rs`): the scanner that finds
//! `@veistra:` marker tokens in a source tree ([`token`], [`scan`]), and the
//! comparison against a design graph that turns what it found into
//! reconciliation outcomes ([`graph`], [`outcome`], [`reconcile`], [`report`]).
//!
//! `crates/schematify-core` — the crate that will eventually own a live,
//! in-process design graph — is built by a separate, concurrent wave, and
//! this crate deliberately does not depend on it. Everything reconciliation
//! needs from a graph is the [`graph::GraphLookup`] trait; see that module's
//! documentation for what a later wave implements to connect the real thing.

// This crate is depended on by the wiring wave that connects
// `schematify-core`, and later by `src-tauri/src/apps/schematify.rs`'s
// `schematify_reconcile_status` handler (PRD section 9.3) — a published
// surface other code reads, the same shape `crates/veistra-rpc` is in. See that
// crate's `lib.rs` for the fuller reasoning; STANDARDS.md §4.1 and §5 ask for
// documented public items and private modules with flat re-exports, enforced
// here rather than in `[workspace.lints]` because it is not true of
// `src-tauri`.
#![warn(missing_docs)]
#![warn(unreachable_pub)]

mod graph;
mod outcome;
mod reconcile;
mod report;
mod scan;
mod token;

pub use graph::{GraphLoadError, GraphLookup, InMemoryGraph, JsonFileGraph, NodeFacts};
pub use outcome::{EvidenceSite, OutcomeKind, ReconcileOutcome};
pub use reconcile::{exit_code, has_error, reconcile, ReconcileRun};
pub use report::{
    render_json, render_text, summarize, write_run_files, ReportError, Summary, RECONCILE_SCHEMA,
};
pub use scan::{scan_tree, Occurrence, ScanResult, SkippedFile};
pub use token::{parse_captures, parse_token, token_pattern, TOKEN_PREFIX};
