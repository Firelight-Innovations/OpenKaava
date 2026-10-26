//! The bundle identifier, pinned, and every identifier it replaced.
//!
//! Four things derive from `tauri.conf.json`'s `identifier` and only the first
//! is ours to redirect: the config directory, the WebView2 profile beside it,
//! the single-instance mutex, and — by hand — the keyring service in
//! `plugins::install`. Moving it moves all four at once, which is what orphaned
//! a live directory when `com.firelightinnovations.helve` became
//! `com.firelightinnovations.openkaava`, since renamed again to the name below.
//! So it is a constant here as well as a field there, and
//! `scripts/check-identity.mjs` fails the build when the two disagree.
//!
//! `productName` is the other half of what a rename moves, is checked by that
//! same script, and is deliberately not here: nothing in Rust reads it.
//! `docs/dev/user-data.md` has both, and the alternatives rejected on the way.

/// What `tauri.conf.json` must say, and what `plugins::install`'s
/// `KEYRING_SERVICE` must be.
pub const IDENTIFIER: &str = "com.firelightinnovations.veistra";

/// Every identifier [`IDENTIFIER`] has replaced, newest first.
///
/// `userdata::adopt` walks this in order. Order is the contract: a machine that
/// has been through two renames has two orphaned directories, and the newest is
/// the one holding what the user last worked in.
pub const SUPERSEDED: &[&str] = &[
    "com.firelightinnovations.openkaava",
    "com.firelightinnovations.helve",
];

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory cannot supersede itself: adoption would move the current
    /// config directory onto its own path.
    #[test]
    fn the_identifier_is_not_also_superseded() {
        assert!(
            !SUPERSEDED.contains(&IDENTIFIER),
            "{IDENTIFIER} is in SUPERSEDED, so adoption would try to adopt itself"
        );
    }

    /// Asserted in Rust as well as in `check-identity.mjs`, so the one consumer
    /// Tauri does not derive for us cannot drift under `cargo test` alone.
    #[test]
    fn the_keyring_service_is_the_identifier() {
        assert_eq!(crate::plugins::install::KEYRING_SERVICE, IDENTIFIER);
    }

    /// A typo here is otherwise silent: adoption looks for a directory that
    /// never existed, and a missing one is the ordinary case.
    #[test]
    fn every_superseded_identifier_is_reverse_dns() {
        for id in SUPERSEDED {
            assert!(
                id.contains('.') && !id.contains(char::is_whitespace),
                "{id:?} does not look like a bundle identifier"
            );
        }
    }
}
