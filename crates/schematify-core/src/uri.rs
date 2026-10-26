//! The `schematify://` reference scheme of PRD section 3.4.
//!
//! Four schemes collapsed into one when Forger and Journeyman merged:
//! `forger://`, `journeyman://` and `decision://` are retired, and every
//! stored reference now names a kind and a UUID. The kind is in the URI rather
//! than inferred from the target, so a resolver knows which directory to open
//! before it has read anything.
//!
//! A reference stores the id and never the slug. PRD section 3.3 is the
//! worked example: `schematify://decision/<uuid>` is stored and
//! `DEC-TEC-AUTH-004` is drawn, and the two differ by design.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use uuid::Uuid;

/// The prefix every Schematify reference carries.
const SCHEME: &str = "schematify://";

/// Which collection a reference points into.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum UriKind {
    /// A service, module, or facet, under `nodes/`.
    Node,
    /// A product screen, under `screens/`.
    Screen,
    /// A product flow, under `flows/`.
    Flow,
    /// A decision log entry, under `decisions/`.
    Decision,
}

impl UriKind {
    /// The word this kind writes into a URI.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Screen => "screen",
            Self::Flow => "flow",
            Self::Decision => "decision",
        }
    }

    /// The directory under `.veistra/` that holds this kind.
    #[must_use]
    pub fn directory(self) -> &'static str {
        match self {
            Self::Node => "nodes",
            Self::Screen => "screens",
            Self::Flow => "flows",
            Self::Decision => "decisions",
        }
    }

    fn parse(word: &str) -> Option<Self> {
        match word {
            "node" => Some(Self::Node),
            "screen" => Some(Self::Screen),
            "flow" => Some(Self::Flow),
            "decision" => Some(Self::Decision),
            _ => None,
        }
    }
}

impl fmt::Display for UriKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One resolved `schematify://` reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Uri {
    /// The collection the reference points into.
    pub kind: UriKind,
    /// The identifier of the thing referenced.
    pub id: Uuid,
}

impl Uri {
    /// A reference to a service, module, or facet.
    #[must_use]
    pub fn node(id: Uuid) -> Self {
        Self {
            kind: UriKind::Node,
            id,
        }
    }

    /// A reference to a product screen.
    #[must_use]
    pub fn screen(id: Uuid) -> Self {
        Self {
            kind: UriKind::Screen,
            id,
        }
    }

    /// A reference to a product flow.
    #[must_use]
    pub fn flow(id: Uuid) -> Self {
        Self {
            kind: UriKind::Flow,
            id,
        }
    }

    /// A reference to a decision log entry.
    #[must_use]
    pub fn decision(id: Uuid) -> Self {
        Self {
            kind: UriKind::Decision,
            id,
        }
    }

    /// Read a reference back from its stored form.
    ///
    /// # Errors
    ///
    /// Returns [`UriError`] when the scheme, the kind word, or the UUID is
    /// wrong. A retired scheme is named in the error rather than reported as a
    /// generic parse failure, because the fix for one is a rewrite and the fix
    /// for the other is a correction.
    pub fn parse(text: &str) -> Result<Self, UriError> {
        for retired in ["forger://", "journeyman://", "decision://"] {
            if text.starts_with(retired) {
                return Err(UriError::RetiredScheme {
                    scheme: retired,
                    text: text.to_owned(),
                });
            }
        }

        let rest = text
            .strip_prefix(SCHEME)
            .ok_or_else(|| UriError::NotSchematify {
                text: text.to_owned(),
            })?;

        let (word, id) = rest.split_once('/').ok_or_else(|| UriError::NoKind {
            text: text.to_owned(),
        })?;

        let kind = UriKind::parse(word).ok_or_else(|| UriError::UnknownKind {
            kind: word.to_owned(),
        })?;

        let id = Uuid::parse_str(id).map_err(|_| UriError::BadUuid {
            text: id.to_owned(),
        })?;

        Ok(Self { kind, id })
    }
}

impl fmt::Display for Uri {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{SCHEME}{}/{}", self.kind.as_str(), self.id)
    }
}

impl FromStr for Uri {
    type Err = UriError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        Self::parse(text)
    }
}

impl Serialize for Uri {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for Uri {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::parse(&text).map_err(serde::de::Error::custom)
    }
}

/// Why a reference did not parse.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UriError {
    /// A `forger://`, `journeyman://` or `decision://` reference survived the
    /// wave 1 rewrite.
    #[error("retired scheme {scheme} in {text:?}: rewrite it as schematify://")]
    RetiredScheme {
        /// The scheme that should no longer exist.
        scheme: &'static str,
        /// The whole reference, so a rewrite can find it.
        text: String,
    },

    /// The reference did not start with `schematify://`.
    #[error("not a Schematify reference: {text:?}")]
    NotSchematify {
        /// The text that was offered.
        text: String,
    },

    /// The reference named no collection.
    #[error("no kind in {text:?}: expected schematify://<kind>/<uuid>")]
    NoKind {
        /// The text that was offered.
        text: String,
    },

    /// The collection word was not one of the four.
    #[error("unknown kind {kind:?}: expected node, screen, flow, or decision")]
    UnknownKind {
        /// The word that was read.
        kind: String,
    },

    /// The tail of the reference was not a UUID.
    #[error("not a uuid: {text:?}")]
    BadUuid {
        /// The text that was read as an identifier.
        text: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0192f4a1-4c3d-7890-a1b2-c3d4e5f6a7b8";

    fn sample() -> Uuid {
        Uuid::parse_str(ID).unwrap()
    }

    #[test]
    fn every_kind_round_trips_through_text() {
        let id = sample();
        for uri in [
            Uri::node(id),
            Uri::screen(id),
            Uri::flow(id),
            Uri::decision(id),
        ] {
            assert_eq!(Uri::parse(&uri.to_string()).unwrap(), uri);
        }
    }

    #[test]
    fn a_uri_round_trips_through_json() {
        let uri = Uri::decision(sample());
        let text = serde_json::to_string(&uri).unwrap();
        assert_eq!(text, format!("\"schematify://decision/{ID}\""));
        assert_eq!(serde_json::from_str::<Uri>(&text).unwrap(), uri);
    }

    #[test]
    fn a_retired_scheme_is_named_in_the_error() {
        let err = Uri::parse(&format!("decision://{ID}")).unwrap_err();
        assert!(matches!(
            err,
            UriError::RetiredScheme {
                scheme: "decision://",
                ..
            }
        ));
        assert!(Uri::parse("forger://node/x").is_err());
        assert!(Uri::parse("journeyman://screen/x").is_err());
    }

    #[test]
    fn a_bad_kind_and_a_bad_uuid_report_separately() {
        assert!(matches!(
            Uri::parse(&format!("schematify://widget/{ID}")),
            Err(UriError::UnknownKind { .. })
        ));
        assert!(matches!(
            Uri::parse("schematify://node/not-a-uuid"),
            Err(UriError::BadUuid { .. })
        ));
        assert!(matches!(
            Uri::parse("schematify://node"),
            Err(UriError::NoKind { .. })
        ));
        assert!(matches!(
            Uri::parse("https://example.com"),
            Err(UriError::NotSchematify { .. })
        ));
    }

    #[test]
    fn a_kind_names_its_directory() {
        assert_eq!(UriKind::Node.directory(), "nodes");
        assert_eq!(UriKind::Decision.directory(), "decisions");
        assert_eq!(UriKind::Screen.to_string(), "screen");
    }
}
