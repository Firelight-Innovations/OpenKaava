//! Parses the reference tool's real `veistra-tool.toml` off disk.
//!
//! The unit tests in `lib.rs` assert against a copy of that document pasted
//! into the test file, which proves the parser agrees with itself but not
//! that it agrees with `examples/echo-tool`. Those two are written by
//! different hands and drift apart quietly: the schema gains a required key,
//! the example doesn't, and nothing notices until a tool repo copies the
//! example and fails to load. This test reads the actual file, so the example
//! and the schema can only ever be wrong together.

use std::path::PathBuf;
use veistra_tool_manifest::ToolManifest;

fn echo_tool_checkout() -> PathBuf {
    // `CARGO_MANIFEST_DIR` is this crate's directory, so the example is two
    // levels up and back down. Read from the environment rather than
    // `env!`: Cargo sets the same variable at test-binary launch, and
    // several worktrees sharing one `CARGO_TARGET_DIR` can otherwise reuse a
    // test binary compiled in a worktree that has since been removed,
    // baking in a path that no longer exists.
    manifest_dir().join("../../examples/echo-tool")
}

/// `CARGO_MANIFEST_DIR`, preferring the value Cargo puts in the environment
/// of a test binary it launches over the one baked in at compile time.
///
/// The existence check below is not redundant with reading the environment:
/// it catches the rarer case where a stale binary somehow still ran (no
/// `CARGO_MANIFEST_DIR` in its environment, so it fell back to the
/// compile-time value), and names the problem instead of leaving a bare
/// `NotFound` for the next agent to puzzle over.
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

#[test]
fn reference_tool_manifest_loads_from_disk() {
    let checkout = echo_tool_checkout();
    let manifest = ToolManifest::load(&checkout)
        .unwrap_or_else(|e| panic!("examples/echo-tool/veistra-tool.toml should load: {e}"));

    // `id` has to match the `[[tool]]` entry the stack manifest would carry,
    // and the protocol says the host rejects a tool whose `veistra/hello` reply
    // disagrees with this — so it is the one field with two sources of truth.
    assert_eq!(manifest.tool.id, "echo");
    assert_eq!(
        manifest.core.expect("the example declares a [core]").args,
        vec!["--veistra-rpc".to_string()]
    );
    assert!(manifest
        .frontend
        .expect("the example declares a [frontend]")
        .dev_url
        .is_some());
}

/// The example declares no `[[surface]]`, and must not have to.
///
/// This is the regression guard for the change that made a package carry
/// several surfaces: every manifest written before that key existed still has
/// to load, and still has to end up with something mountable. If adding a
/// surface to the example is ever the fix for this test, the format moved in a
/// way `docs/tool-protocol.md` §6 does not permit under protocol 1.
#[test]
fn reference_tool_gets_one_synthesised_surface() {
    let manifest = ToolManifest::load(&echo_tool_checkout()).unwrap();

    assert_eq!(manifest.surfaces.len(), 1);
    assert_eq!(
        manifest.surfaces[0].id,
        veistra_tool_manifest::DEFAULT_SURFACE_ID
    );
    assert_eq!(manifest.surfaces[0].path, None, "serves the bundle root");
}

#[test]
fn reference_tool_frontend_path_stays_inside_the_checkout() {
    let checkout = echo_tool_checkout();
    let manifest = ToolManifest::load(&checkout).unwrap();

    // `load` already rejects an escaping path, so this is really asserting
    // that the example models the thing tool authors should copy.
    let dist = manifest
        .resolve_dist(&checkout)
        .expect("the example declares a [frontend]");
    assert!(
        dist.starts_with(&checkout),
        "dist escaped: {}",
        dist.display()
    );
}
