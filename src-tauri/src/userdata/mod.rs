//! Everything Veistra remembers about a person, and what keeps it across an
//! install.
//!
//! Eight JSON files and a directory of plugin checkouts sit under
//! `%APPDATA%\<identifier>\`. None of them is the repository's, none belongs to
//! a project, and until the rename that produced this module nobody had to
//! think about the path they share.
//!
//! `docs/dev/user-data.md` is the design note — what is at risk, what is
//! precious and what is merely reconstructible, and the alternatives rejected
//! on the way here.

/// Moves the directory a replaced identifier left behind onto the current one,
/// once, at the start of the launch that first notices.
pub mod adopt;

/// The three most recent copies of a file that was about to be replaced by
/// something derived, and the one handed back when its build returns.
pub mod backup;

/// The bundle identifier every path here hangs off, pinned, and the ones it has
/// replaced.
pub mod identity;

/// How all eight files are read and written: the format field, the refusal to
/// parse a file from a newer build, and the durable write those modules used to
/// carry a copy of each.
pub mod store;
