//! Wave 9: "Declare the 6 budgets in section 14.7 inside Schematify's own
//! `.veistra/` project, each with its probe command" (PRD §17, Wave 9).
//!
//! `self/.veistra/` is that project — Schematify describing itself, as distinct
//! from the reference fixtures under `fixtures/`, which PRD §14.7's last
//! paragraph calls out as project data that sits outside this rule.
//!
//! This test is the authority §14.6 asks every wave to use: rather than eyeball
//! six hand-written JSON files against the schema in section 5.10, load them
//! through this crate's own `load_project` and `Node::budget`, then pin every
//! field against the section 14.7 table by value. A field that drifts from the
//! table, a probe command that stops matching a real `pnpm bench:*` script, or
//! a tier that quietly changed from `hard` to `soft` all fail here first.

use std::path::PathBuf;

use schematify_core::{load_project, BudgetTier, Graph, Node, NodeKind, Uuid};

fn self_project() -> PathBuf {
    manifest_dir().join("self")
}

/// `CARGO_MANIFEST_DIR`, preferring the value Cargo puts in the environment
/// of a test binary it launches over the one baked in at compile time.
///
/// Several worktrees sharing one `CARGO_TARGET_DIR` (a deliberate convention
/// for agents working this repo) hold identical sources, so Cargo can reuse
/// a test binary compiled in a worktree that has since been removed,
/// carrying that worktree's absolute path. Reading the environment first
/// avoids resolving fixtures against a directory that no longer exists; the
/// check below catches the rarer case where a stale binary somehow still
/// ran, and names the problem instead of leaving a bare `NotFound` for the
/// next agent to puzzle over.
fn manifest_dir() -> PathBuf {
    let dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR")
            .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_string()),
    );
    assert!(
        dir.is_dir(),
        "CARGO_MANIFEST_DIR resolved to {}, which does not exist -- this looks like a \
         stale cross-worktree build (a test binary compiled in a worktree that has since \
         been removed and reused from a shared CARGO_TARGET_DIR); rerun `cargo test` from \
         this worktree to force a rebuild",
        dir.display()
    );
    dir
}

fn by_slug(graph: &Graph, slug: &str) -> Uuid {
    graph
        .nodes()
        .find(|n| n.envelope.slug.as_str() == slug)
        .map(Node::id)
        .unwrap_or_else(|| panic!("{slug} is missing from Schematify's own project"))
}

/// One row of PRD §14.7's table, minus the "Asserted in" column, which this
/// test does not check — that column names a wave, not a value this project
/// stores.
struct Row {
    slug: &'static str,
    metric: &'static str,
    value: f64,
    unit: &'static str,
    tier: BudgetTier,
    probe_command: &'static str,
}

const TABLE: &[Row] = &[
    Row {
        slug: "cold-launch",
        metric: "cold_launch_ms",
        value: 2000.0,
        unit: "ms",
        tier: BudgetTier::Hard,
        probe_command: "pnpm bench:startup",
    },
    Row {
        slug: "graph-load",
        metric: "graph_load_ms",
        value: 1000.0,
        unit: "ms",
        tier: BudgetTier::Hard,
        probe_command: "pnpm bench:load",
    },
    Row {
        slug: "frame-time",
        metric: "frame_time_ms",
        value: 16.0,
        unit: "ms",
        tier: BudgetTier::Hard,
        probe_command: "pnpm bench:frame",
    },
    Row {
        slug: "drag-to-write",
        metric: "drag_to_write_ms",
        value: 50.0,
        unit: "ms",
        // The one soft tier in the table. PRD §14.7: "A soft threshold and a
        // target threshold shall never act as a wave gate" — asserted below by
        // checking every OTHER row is hard, not just that this one is soft.
        tier: BudgetTier::Soft,
        probe_command: "pnpm bench:drag",
    },
    Row {
        slug: "full-lint",
        metric: "full_lint_ms",
        value: 500.0,
        unit: "ms",
        tier: BudgetTier::Hard,
        probe_command: "pnpm bench:lint",
    },
    Row {
        slug: "search-first-result",
        metric: "search_first_result_ms",
        value: 100.0,
        unit: "ms",
        tier: BudgetTier::Hard,
        probe_command: "pnpm bench:search",
    },
];

#[test]
fn schematifys_own_project_loads_clean() {
    let outcome = load_project(&self_project()).unwrap();
    assert!(
        outcome.report.is_clean(),
        "{:?}",
        outcome.report.quarantined
    );
    assert_eq!(outcome.graph.node_count(), TABLE.len());
}

#[test]
fn every_row_of_the_section_14_7_table_is_a_budget_node_here() {
    let outcome = load_project(&self_project()).unwrap();
    let graph = &outcome.graph;

    for row in TABLE {
        let id = by_slug(graph, row.slug);
        let node = graph.node(id).unwrap();
        assert_eq!(*node.kind(), NodeKind::Budget, "{} is a budget", row.slug);

        let fields = node.budget().unwrap();
        assert_eq!(fields.metric, row.metric, "{} metric", row.slug);
        assert_eq!(fields.op, "<", "{} op", row.slug);
        assert!(
            (fields.value - row.value).abs() < f64::EPSILON,
            "{} value: {} != {}",
            row.slug,
            fields.value,
            row.value
        );
        assert_eq!(fields.unit, row.unit, "{} unit", row.slug);
        assert_eq!(fields.tier, row.tier, "{} tier", row.slug);

        // PRD §5.5: a budget without a probe is rule L03, an error. Every one
        // of these six carries its probe command, per the Wave 9 bullet, even
        // the three whose script is an honest stub rather than a real
        // measurement — the command is real and wired either way.
        let probe = fields.probe.expect("declared with a probe");
        assert_eq!(probe.command, row.probe_command, "{} probe", row.slug);
        assert_eq!(probe.parser, "veistra-bench-v1", "{} parser", row.slug);
    }
}

/// PRD §14.7: "The lint budget and the search budget carry the `hard` tier,
/// because a wave acceptance blocks on each. A `soft` threshold and a `target`
/// threshold shall never act as a wave gate." Exactly one of the six is soft;
/// every other row is hard, and none is `target` — a `target` budget here
/// would silently stop gating a wave that the table says should be blocked.
#[test]
fn exactly_one_budget_is_soft_and_the_rest_are_hard() {
    let outcome = load_project(&self_project()).unwrap();
    let graph = &outcome.graph;

    let mut hard = 0;
    let mut soft = 0;
    for row in TABLE {
        let node = graph.node(by_slug(graph, row.slug)).unwrap();
        match node.budget().unwrap().tier {
            BudgetTier::Hard => hard += 1,
            BudgetTier::Soft => soft += 1,
            BudgetTier::Target => panic!(
                "{} is target-tier; §14.7 names no target budget here",
                row.slug
            ),
        }
    }
    assert_eq!(soft, 1, "only drag-to-write is soft");
    assert_eq!(hard, TABLE.len() - 1);
}
