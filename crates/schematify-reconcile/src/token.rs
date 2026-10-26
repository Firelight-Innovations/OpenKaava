//! The marker-token grammar (PRD `SCHEMATIFY-PRD.md` section 9.1):
//!
//! ```text
//! @veistra:0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8 token-verifier.verify_signature
//! ```
//!
//! found by plain regular expression rather than parsed as a doc comment,
//! because — in the PRD's own words — "a docstring parser breaks on the
//! first language nobody anticipated." The UUID is authoritative; the
//! trailing slug is a human grep aid and carries no semantics reconciliation
//! depends on.
//!
//! A malformed candidate — a truncated or non-hex UUID, wrong hyphen
//! placement, or no UUID at all after the prefix — simply does not match.
//! There is no separate "malformed token" outcome (PRD section 9.2 names
//! exactly four outcomes and this is not one of them); a near-miss is
//! invisible to the scanner, which is indistinguishable from the marker
//! never having been written at all.

use regex::{Captures, Regex};
use uuid::Uuid;

/// The literal prefix every marker token starts with.
pub const TOKEN_PREFIX: &str = "@veistra:";

/// Build the regular expression that finds every well-formed marker token in
/// a line of text. Compiled once per scan (by the caller) rather than once
/// per line — `Regex::new` is not cheap enough to call in a hot loop.
pub fn token_pattern() -> Regex {
    // A fixed, hand-checked pattern: `pattern_has_exactly_the_id_and_slug_groups`
    // below is what would catch an extra or reordered capture group here, at
    // test time rather than in a scanner run.
    #[allow(clippy::unwrap_used)]
    Regex::new(
        r"@veistra:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[ \t]+([A-Za-z0-9_][A-Za-z0-9_.\-]*))?",
    )
    .unwrap()
}

/// Pull the id and optional slug out of one regex match. `None` only if the
/// UUID capture fails to parse as a UUID, which `token_pattern`'s character
/// classes already make unreachable in practice — kept as a `Result`-free
/// `Option` so a future looser pattern stays safe.
pub fn parse_captures(caps: &Captures<'_>) -> Option<(Uuid, Option<String>)> {
    let id = Uuid::parse_str(caps.get(1)?.as_str()).ok()?;
    let slug = caps.get(2).map(|m| m.as_str().to_string());
    Some((id, slug))
}

/// Parse a single candidate string as exactly one marker token, starting at
/// its first character. This is `token_pattern`'s grammar exposed as a direct
/// function for tests and for a caller that has already isolated one line —
/// the scanner itself uses `token_pattern` with `captures_iter` instead, to
/// find a token anywhere inside a longer line.
///
/// Returns `None` for anything that is not a well-formed token beginning at
/// offset 0 — including a match that starts later in the string, which is
/// what distinguishes "this string does not open with a token" from "this
/// string contains a token somewhere," a distinction the scanner does not
/// need but the grammar tests do.
pub fn parse_token(candidate: &str) -> Option<(Uuid, Option<String>)> {
    let re = token_pattern();
    let caps = re.captures(candidate)?;
    if caps.get(0)?.start() != 0 {
        return None;
    }
    parse_captures(&caps)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pattern_has_exactly_the_id_and_slug_groups() {
        // `parse_captures` reads the id from group 1 and the slug from
        // group 2 by position, not by name. `finds_a_token_anywhere_in_a_line_via_captures_iter`
        // and the parse tests below would catch a group that shifts what
        // position 1 or 2 hold, but not one that is added or removed
        // without disturbing those two — an appended trailing group, say.
        // `captures_len()` (the whole match plus every capturing group)
        // pins the count so that stays caught too.
        let re = token_pattern();
        assert_eq!(re.captures_len(), 3);
    }

    #[test]
    fn parses_a_well_formed_token_with_slug() {
        let (id, slug) = parse_token(
            "@veistra:0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8 token-verifier.verify_signature",
        )
        .expect("well-formed token should parse");
        assert_eq!(id.to_string(), "0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8");
        assert_eq!(slug.as_deref(), Some("token-verifier.verify_signature"));
    }

    #[test]
    fn parses_a_token_with_no_slug() {
        let (id, slug) =
            parse_token("@veistra:0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8").expect("should parse");
        assert_eq!(id.to_string(), "0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8");
        assert_eq!(slug, None);
    }

    #[test]
    fn rejects_missing_prefix() {
        assert_eq!(
            parse_token("0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8 token-verifier"),
            None
        );
    }

    #[test]
    fn rejects_truncated_uuid() {
        assert_eq!(
            parse_token("@veistra:0192f4a1-4c3d-7890-a1b2 token-verifier"),
            None
        );
    }

    #[test]
    fn rejects_non_hex_uuid() {
        assert_eq!(
            parse_token("@veistra:zzzzzzzz-4c3d-7890-a1b2-c3d4e5f6a7b8 token-verifier"),
            None
        );
    }

    #[test]
    fn rejects_wrong_hyphen_placement() {
        assert_eq!(
            parse_token("@veistra:0192f4a14c3d-7890-a1b2-c3d4e5f6a7b8 token-verifier"),
            None
        );
    }

    #[test]
    fn rejects_bare_prefix_with_nothing_following() {
        assert_eq!(parse_token("@veistra:"), None);
        assert_eq!(parse_token("@veistra: token-verifier"), None);
    }

    #[test]
    fn rejects_a_token_that_does_not_start_at_offset_zero() {
        assert_eq!(
            parse_token("// @veistra:0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8 token-verifier"),
            None
        );
    }

    #[test]
    fn finds_a_token_anywhere_in_a_line_via_captures_iter() {
        let re = token_pattern();
        let line =
            "// @veistra:0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8 token-verifier.verify_signature";
        let caps: Vec<_> = re.captures_iter(line).collect();
        assert_eq!(caps.len(), 1);
        let (id, slug) = parse_captures(&caps[0]).expect("should parse from captures");
        assert_eq!(id.to_string(), "0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8");
        assert_eq!(slug.as_deref(), Some("token-verifier.verify_signature"));
    }

    #[test]
    fn finds_two_tokens_on_one_line() {
        let re = token_pattern();
        let line = "@veistra:0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8 a @veistra:0192f4a2-4c3d-7890-a1b2-c3d4e5f6a7b8 b";
        let caps: Vec<_> = re.captures_iter(line).collect();
        assert_eq!(caps.len(), 2);
    }
}
