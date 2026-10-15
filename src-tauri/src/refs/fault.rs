//! Why a reference could not be resolved: a word a surface can map to its own
//! sentence, and a sentence for everyone else.
//!
//! The word travels as `data.reason` on a `refs/*` error and as `reason` on
//! each reference a call could not use. Branch on it, never on the sentence.

use kaava_rpc::{RpcError, INVALID_PARAMS};
use serde::Serialize;
use serde_json::json;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    /// The call is malformed: a parameter missing, mistyped or over its cap.
    BadParams,
    /// Not a `kaava://` reference, or a path no reference may name.
    BadUri,
    /// No project is open, or the surface is in no cluster.
    NoProject,
    /// Nothing is there by that name.
    Missing,
    /// The name fits more than one thing, such as a frame name two share.
    Ambiguous,
    /// It leads outside the project, through a link or otherwise.
    Outside,
    /// A secret, refused where reading it would show it.
    Secret,
    /// What answers it, the Canvas app or Design Mode, could not.
    Unavailable,
    /// It is there but could not be read: a broken record, a file error.
    Unreadable,
}

impl Reason {
    pub fn word(self) -> &'static str {
        match self {
            Reason::BadParams => "bad-params",
            Reason::BadUri => "bad-uri",
            Reason::NoProject => "no-project",
            Reason::Missing => "missing",
            Reason::Ambiguous => "ambiguous",
            Reason::Outside => "outside",
            Reason::Secret => "secret",
            Reason::Unavailable => "unavailable",
            Reason::Unreadable => "unreadable",
        }
    }
}

/// A reference that could not be resolved, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fault {
    pub reason: Reason,
    pub message: String,
}

impl Fault {
    pub fn new(reason: Reason, message: impl Into<String>) -> Self {
        Fault {
            reason,
            message: message.into(),
        }
    }

    /// As a `refs/*` error: invalid params, with the word in `data.reason`.
    pub fn rpc(self) -> RpcError {
        let data = json!({ "reason": self.reason.word() });
        RpcError::with_data(INVALID_PARAMS, self.message, data)
    }
}

/// A sentence with no better word is a read that failed.
impl From<String> for Fault {
    fn from(message: String) -> Self {
        Fault::new(Reason::Unreadable, message)
    }
}

impl From<&str> for Fault {
    fn from(message: &str) -> Self {
        Fault::new(Reason::Unreadable, message)
    }
}

impl From<Fault> for String {
    fn from(fault: Fault) -> Self {
        fault.message
    }
}

impl fmt::Display for Fault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fault_carries_its_word_as_data_and_its_sentence_as_the_message() {
        let e = Fault::new(Reason::Missing, "there is no `a.gd` in this project").rpc();
        assert_eq!(e.code, INVALID_PARAMS);
        assert_eq!(e.message, "there is no `a.gd` in this project");
        assert_eq!(e.data, Some(json!({ "reason": "missing" })));
    }

    #[test]
    fn the_word_is_the_one_serde_writes() {
        for reason in [
            Reason::BadParams,
            Reason::BadUri,
            Reason::NoProject,
            Reason::Missing,
            Reason::Ambiguous,
            Reason::Outside,
            Reason::Secret,
            Reason::Unavailable,
            Reason::Unreadable,
        ] {
            assert_eq!(json!(reason), json!(reason.word()));
        }
    }

    #[test]
    fn a_bare_sentence_is_an_unreadable_fault_and_back() {
        let fault = Fault::from("the file is locked".to_string());
        assert_eq!(fault.reason, Reason::Unreadable);
        assert_eq!(String::from(fault), "the file is locked");
    }
}
