//! Masking for the few strings that leave an agent's process other than its
//! transcript: the tail of its stderr when it dies early, and error messages.
//!
//! Handoff §0.2: Kaava never reads, stores, logs or forwards a login token.
//! The host does not go looking for one — it never opens a credential file and
//! drops every `_auth/*` notification — but an adapter's own error text could
//! still quote one, so anything shown outside the transcript passes through
//! here first. Emails go too: the Claude adapter's stderr names the account.

/// Prefixes of token formats worth recognising on sight.
const TOKEN_PREFIXES: &[&str] = &[
    "sk-",
    "sk_",
    "sess-",
    "ghp_",
    "gho_",
    "ghs_",
    "github_pat_",
    "xox",
    "ya29.",
    "eyJ",
    "AKIA",
    "AIza",
];

/// The shortest word that can be a prefixed token. `sk-1` is not one.
const MIN_PREFIXED: usize = 16;

/// The shortest unprefixed run of key-like characters treated as a secret.
const MIN_BARE: usize = 32;

/// `text` with every token- or email-shaped word replaced.
pub fn mask(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    for c in text.chars() {
        if is_word_char(c) {
            word.push(c);
        } else {
            out.push_str(&mask_word(&word));
            word.clear();
            out.push(c);
        }
    }
    out.push_str(&mask_word(&word));
    out
}

/// Whether `text` holds anything [`mask`] would replace. The token-grep test
/// asserts this is false of every log line.
pub fn looks_secret(text: &str) -> bool {
    mask(text) != text
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+' | '/' | '=' | '@')
}

fn mask_word(word: &str) -> String {
    let trimmed = word.trim_end_matches('.');
    if is_email(trimmed) {
        return format!("<email>{}", &word[trimmed.len()..]);
    }
    if is_token(trimmed) {
        return format!("<redacted>{}", &word[trimmed.len()..]);
    }
    word.to_string()
}

fn is_email(word: &str) -> bool {
    if word.contains('/') {
        return false;
    }
    let Some((local, domain)) = word.split_once('@') else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.')
}

fn is_token(word: &str) -> bool {
    if TOKEN_PREFIXES.iter().any(|p| word.starts_with(p)) && word.len() >= MIN_PREFIXED {
        return true;
    }
    // A long run with both letters and digits and no path separators reads as
    // a key; a long word of letters alone is a word.
    word.len() >= MIN_BARE
        && !word.contains('/')
        && word.chars().any(|c| c.is_ascii_digit())
        && word.chars().any(|c| c.is_ascii_alphabetic())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_masked() {
        let line = "using sk-ant-oat01-AbCdEf0123456789xyz for this";
        assert_eq!(mask(line), "using <redacted> for this");
        assert_eq!(
            mask("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"),
            "Bearer <redacted>"
        );
        // `=` belongs to the word (it pads base64), so the name goes with the
        // value: more than needed, never less.
        assert_eq!(mask("key=AbCdEf0123456789AbCdEf0123456789xx"), "<redacted>");
    }

    #[test]
    fn emails_are_masked_but_keep_their_punctuation() {
        assert_eq!(
            mask("signed in as someone@example.com."),
            "signed in as <email>."
        );
    }

    #[test]
    fn ordinary_text_and_paths_are_left_alone() {
        for text in [
            "claude exited with code 1",
            "C:/Users/someone/.local/bin/claude.exe",
            "@agentclientprotocol/claude-agent-acp@0.90.0",
            "sk-1 is short",
            "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
        ] {
            assert_eq!(mask(text), text, "{text}");
            assert!(!looks_secret(text));
        }
    }
}
