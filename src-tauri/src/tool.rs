//! The vocabulary of the stack: what a tool *is*, and what state it's in.
//!
//! Two layers on purpose:
//!   * `ToolSpec`     — what veistra.toml *declares*. Deserialized from the manifest.
//!   * `ResolvedTool` — that spec joined with what's actually on disk right now.
//!
//! Keeping "declared" and "actual" as separate types means the discovery step
//! can't accidentally overwrite the pinned version with whatever it found.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolKind {
    /// An authoring tool: a window you open while you work.
    ///
    /// The only kind today. It stays an enum rather than collapsing into a
    /// bare marker because `veistra.toml` already writes `kind = "dev-tool"` on
    /// every entry, and removing a field from a manifest format is a migration
    /// while adding a variant to it is not.
    DevTool,
}

/// One `[[tool]]` table from veistra.toml.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct ToolSpec {
    /// Short stable handle, also the default checkout directory name.
    pub id: String,
    pub name: String,
    pub kind: ToolKind,
    pub repo: String,
    /// The pinned semantic version, e.g. "0.1.0". Never a branch name.
    pub version: String,
    #[serde(default)]
    pub description: String,
    /// Override the checkout directory name when it differs from `id`.
    #[serde(default)]
    pub path: Option<String>,
}

impl ToolSpec {
    /// The directory to look for under the checkout root.
    pub fn dir_name(&self) -> &str {
        // `as_deref` turns `&Option<String>` into `Option<&str>` so both arms of
        // `unwrap_or` have the same type.
        self.path.as_deref().unwrap_or(&self.id)
    }
}

/// What discovery found on disk for a declared tool.
///
/// `#[serde(tag = "state")]` makes this serialize as `{ "state": "ready",
/// "version": "0.1.0" }`, which maps cleanly onto a TypeScript discriminated
/// union — see `src/bindings.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum ToolStatus {
    /// Checkout present, and it reports the version we pinned.
    Ready { version: String },
    /// Checkout present, but it reports a different version than the pin.
    Mismatch { expected: String, found: String },
    /// Checkout present, but carries no version marker we recognise (no
    /// Cargo.toml, no package.json). Expected for empty scaffolding repos.
    Unversioned,
    /// Nothing at the expected path.
    Missing,
}

/// A `ToolSpec` plus everything discovery learned about it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTool {
    /// `flatten` splices the spec's fields into this object rather than nesting
    /// them under a `spec` key, so the frontend sees one flat tool object.
    #[serde(flatten)]
    pub spec: ToolSpec,
    pub status: ToolStatus,
    pub checkout_path: PathBuf,
    pub is_git_repo: bool,
}
