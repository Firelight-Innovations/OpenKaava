//! "Agent saw": which image files Claude Code read, shown back to the person.
//!
//! **Transport.** A `PostToolUse` hook (matcher `Read`) appends the hook's JSON
//! payload, one line per call, to `<env>/.kaava/context/.saw.jsonl`, and Kaava
//! reads that file. The alternative was a hook binary posting to the local MCP
//! listener; that needs a shipped executable, a port and token that change on
//! every launch, and `curl` quoting that differs between cmd and bash. A file
//! append needs only `cat`, works with Kaava closed, and cannot fail loudly in
//! the agent's session. The cost is that Kaava polls; it is a stat and a small
//! read.
//!
//! **Consent.** Nothing here runs unless the person turns it on. Enabling edits
//! `<env>/.claude/settings.local.json`, the per-user, git-ignored settings file,
//! merging one hook without touching any other key or hook, and disabling takes
//! exactly that hook back out. A settings file that does not parse is refused,
//! never overwritten.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const SAW_FILE: &str = ".saw.jsonl";
/// Present in our hook's command, and how we find it again.
const MARKER: &str = ".kaava/context/.saw.jsonl";
const MAX_LOG_BYTES: usize = 1024 * 1024;
const KEEP_LOG_BYTES: usize = 256 * 1024;
const MAX_SEEN: usize = 50;
const MAX_THUMB_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
    /// The settings file that is, or would be, edited.
    pub settings_path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Seen {
    pub path: String,
    pub name: String,
    pub mime: String,
    pub missing: bool,
    /// Milliseconds since the epoch, so a rewritten file gets a fresh thumbnail.
    pub modified: u64,
}

pub fn settings_path(root: &Path) -> PathBuf {
    root.join(".claude").join("settings.local.json")
}

fn saw_path(root: &Path) -> PathBuf {
    crate::context::store_dir(root).join(SAW_FILE)
}

/// The hook's command line. `mkdir -p` because Claude can run before Kaava has
/// ever created the store; bash is what Claude Code runs hooks with on every
/// platform it supports, Git Bash included.
fn command() -> String {
    format!(
        "mkdir -p \"$CLAUDE_PROJECT_DIR/.kaava/context\" && cat >> \"$CLAUDE_PROJECT_DIR/{MARKER}\""
    )
}

fn is_ours(hook: &Value) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .is_some_and(|c| c.contains(MARKER))
}

fn read_settings(root: &Path) -> Result<Value, String> {
    let path = settings_path(root);
    match std::fs::read_to_string(&path) {
        Ok(text) if text.trim().is_empty() => Ok(json!({})),
        Ok(text) => {
            let v: Value = serde_json::from_str(&text).map_err(|e| {
                format!(
                    "{} is not valid JSON ({e}); fix or remove it, and Kaava will not touch it",
                    path.display()
                )
            })?;
            if v.is_object() {
                Ok(v)
            } else {
                Err(format!("{} is not a JSON object", path.display()))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

fn write_settings(root: &Path, value: &Value) -> Result<(), String> {
    let path = settings_path(root);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())? + "\n";
    let tmp = path.with_extension("json.kaava-tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not replace {}: {e}", path.display())
    })
}

/// Is our hook in the settings file.
pub fn status(root: &Path) -> Status {
    let installed = read_settings(root).is_ok_and(|s| {
        s.pointer("/hooks/PostToolUse")
            .and_then(Value::as_array)
            .is_some_and(|groups| {
                groups.iter().any(|g| {
                    g.get("hooks")
                        .and_then(Value::as_array)
                        .is_some_and(|hs| hs.iter().any(is_ours))
                })
            })
    });
    Status {
        installed,
        settings_path: settings_path(root).to_string_lossy().into_owned(),
    }
}

/// Add the hook, keeping everything else. Idempotent.
pub fn enable(root: &Path) -> Result<Status, String> {
    let mut settings = read_settings(root)?;
    if status(root).installed {
        return Ok(status(root));
    }
    crate::context::ensure_dir(root).map_err(|e| e.message)?;
    let obj = settings
        .as_object_mut()
        .ok_or("settings.local.json is not a JSON object")?;
    let hooks = obj
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("`hooks` in settings.local.json is not an object")?;
    let groups = hooks
        .entry("PostToolUse")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or("`hooks.PostToolUse` in settings.local.json is not an array")?;
    groups.push(json!({
        "matcher": "Read",
        "hooks": [{ "type": "command", "command": command() }]
    }));
    write_settings(root, &settings)?;
    Ok(status(root))
}

/// Take our hook out and nothing else, pruning only what that leaves empty.
pub fn disable(root: &Path) -> Result<Status, String> {
    if !settings_path(root).exists() {
        return Ok(status(root));
    }
    let mut settings = read_settings(root)?;
    let mut emptied = false;
    if let Some(groups) = settings
        .pointer_mut("/hooks/PostToolUse")
        .and_then(Value::as_array_mut)
    {
        for g in groups.iter_mut() {
            if let Some(hs) = g.get_mut("hooks").and_then(Value::as_array_mut) {
                hs.retain(|h| !is_ours(h));
            }
        }
        groups.retain(|g| {
            g.get("hooks")
                .and_then(Value::as_array)
                .is_none_or(|hs| !hs.is_empty())
        });
        emptied = groups.is_empty();
    }
    if emptied {
        if let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) {
            hooks.remove("PostToolUse");
            if hooks.is_empty() {
                if let Some(obj) = settings.as_object_mut() {
                    obj.remove("hooks");
                }
            }
        }
    }
    write_settings(root, &settings)?;
    Ok(status(root))
}

fn mime_of(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// The log, trimmed on disk to its tail once it grows past a megabyte.
fn read_log(root: &Path) -> String {
    let path = saw_path(root);
    let Ok(bytes) = std::fs::read(&path) else {
        return String::new();
    };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if text.len() <= MAX_LOG_BYTES {
        return text;
    }
    let mut from = text.len() - KEEP_LOG_BYTES;
    while !text.is_char_boundary(from) {
        from += 1;
    }
    let from = text[from..].find('\n').map_or(text.len(), |i| from + i + 1);
    let kept = text[from..].to_string();
    let _ = std::fs::write(&path, &kept);
    kept
}

/// Images the agent has read, newest first, each path once.
pub fn seen(root: &Path) -> Vec<Seen> {
    let mut out: Vec<Seen> = Vec::new();
    for line in read_log(root).lines().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("tool_name").and_then(Value::as_str) != Some("Read") {
            continue;
        }
        let Some(file) = v.pointer("/tool_input/file_path").and_then(Value::as_str) else {
            continue;
        };
        let Some(mime) = mime_of(file) else { continue };
        let mut path = PathBuf::from(file);
        if path.is_relative() {
            let base = v.get("cwd").and_then(Value::as_str).map(Path::new);
            path = base.unwrap_or(root).join(path);
        }
        let path = path.to_string_lossy().replace('\\', "/");
        if out.iter().any(|s| s.path == path) {
            continue;
        }
        let modified = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        out.push(Seen {
            modified,
            name: path.rsplit('/').next().unwrap_or(&path).to_string(),
            missing: !Path::new(&path).is_file(),
            mime: mime.to_string(),
            path,
        });
        if out.len() >= MAX_SEEN {
            break;
        }
    }
    out
}

/// `(mime, bytes)` for a thumbnail, only for a path the log says was read.
pub fn thumb(root: &Path, path: &str) -> Result<(String, Vec<u8>), String> {
    let found = seen(root)
        .into_iter()
        .find(|s| s.path == path)
        .ok_or("that image is not in the list of files the agent read")?;
    let len = std::fs::metadata(&found.path)
        .map_err(|e| format!("could not read {}: {e}", found.path))?
        .len();
    if len > MAX_THUMB_BYTES {
        return Err("that image is too large to preview".into());
    }
    let bytes = std::fs::read(&found.path).map_err(|e| e.to_string())?;
    Ok((found.mime.clone(), bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn read(root: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(settings_path(root)).unwrap()).unwrap()
    }

    fn payload(tool: &str, file: &str, cwd: &str) -> String {
        json!({"session_id":"s","hook_event_name":"PostToolUse","tool_name":tool,
               "tool_input":{"file_path":file},"cwd":cwd})
        .to_string()
    }

    fn log(root: &Path, lines: &[String]) {
        std::fs::create_dir_all(crate::context::store_dir(root)).unwrap();
        std::fs::write(saw_path(root), lines.join("\n") + "\n").unwrap();
    }

    fn cwd_of(env: &TempDir) -> String {
        env.path().to_string_lossy().replace('\\', "/")
    }

    #[test]
    fn enabling_creates_the_file_and_the_ignored_store() {
        let env = TempDir::new().unwrap();
        assert!(!status(env.path()).installed);
        assert!(enable(env.path()).unwrap().installed);
        let v = read(env.path());
        assert_eq!(v["hooks"]["PostToolUse"][0]["matcher"], "Read");
        assert!(v["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains(MARKER));
        assert!(crate::context::store_dir(env.path())
            .join(".gitignore")
            .exists());
    }

    #[test]
    fn enabling_keeps_every_other_key_and_hook_and_is_idempotent() {
        let env = TempDir::new().unwrap();
        std::fs::create_dir_all(env.path().join(".claude")).unwrap();
        let mine = json!({
            "permissions": {"allow": ["Bash(ls)"]},
            "hooks": {
                "PreToolUse": [{"matcher": "Bash", "hooks": [{"type":"command","command":"echo hi"}]}],
                "PostToolUse": [{"matcher": "Edit", "hooks": [{"type":"command","command":"fmt"}]}]
            }
        });
        std::fs::write(settings_path(env.path()), mine.to_string()).unwrap();
        enable(env.path()).unwrap();
        enable(env.path()).unwrap();
        let v = read(env.path());
        assert_eq!(v["permissions"], mine["permissions"]);
        assert_eq!(v["hooks"]["PreToolUse"], mine["hooks"]["PreToolUse"]);
        let post = v["hooks"]["PostToolUse"].as_array().unwrap();
        assert_eq!(post.len(), 2);
        assert_eq!(post[0], mine["hooks"]["PostToolUse"][0]);
    }

    #[test]
    fn disabling_removes_only_our_hook_and_restores_what_was_there() {
        let env = TempDir::new().unwrap();
        std::fs::create_dir_all(env.path().join(".claude")).unwrap();
        let mine = json!({"hooks":{"PostToolUse":[{"matcher":"Edit","hooks":[{"type":"command","command":"fmt"}]}]},"model":"x"});
        std::fs::write(settings_path(env.path()), mine.to_string()).unwrap();
        enable(env.path()).unwrap();
        assert!(!disable(env.path()).unwrap().installed);
        assert_eq!(read(env.path()), mine);
    }

    #[test]
    fn disabling_prunes_the_hooks_it_alone_created() {
        let env = TempDir::new().unwrap();
        enable(env.path()).unwrap();
        disable(env.path()).unwrap();
        assert_eq!(read(env.path()), json!({}));
    }

    #[test]
    fn a_settings_file_that_does_not_parse_is_refused_and_left_alone() {
        let env = TempDir::new().unwrap();
        std::fs::create_dir_all(env.path().join(".claude")).unwrap();
        std::fs::write(settings_path(env.path()), "{ not json").unwrap();
        assert!(enable(env.path()).unwrap_err().contains("not valid JSON"));
        assert!(disable(env.path()).is_err());
        assert_eq!(
            std::fs::read_to_string(settings_path(env.path())).unwrap(),
            "{ not json"
        );
    }

    #[test]
    fn reads_of_images_are_listed_newest_first_once_each() {
        let env = TempDir::new().unwrap();
        let cwd = cwd_of(&env);
        std::fs::write(env.path().join("a.png"), [1]).unwrap();
        log(
            env.path(),
            &[
                payload("Read", "a.png", &cwd),
                payload("Read", "src/main.rs", &cwd),
                payload("Edit", "b.png", &cwd),
                "garbage".into(),
                payload("Read", "gone.JPG", &cwd),
                payload("Read", &format!("{cwd}/a.png"), &cwd),
            ],
        );
        let s = seen(env.path());
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].name, "a.png");
        assert!(!s[0].missing);
        assert_eq!(s[1].name, "gone.JPG");
        assert!(s[1].missing);
        assert_eq!(s[1].mime, "image/jpeg");
    }

    #[test]
    fn a_thumbnail_is_served_only_for_a_path_the_agent_read() {
        let env = TempDir::new().unwrap();
        let cwd = cwd_of(&env);
        std::fs::write(env.path().join("a.png"), [1, 2]).unwrap();
        std::fs::write(env.path().join("secret.png"), [9]).unwrap();
        log(env.path(), &[payload("Read", "a.png", &cwd)]);
        assert_eq!(
            thumb(env.path(), &format!("{cwd}/a.png")).unwrap().1,
            vec![1, 2]
        );
        assert!(thumb(env.path(), &format!("{cwd}/secret.png")).is_err());
    }

    #[test]
    fn no_log_is_an_empty_list() {
        assert!(seen(TempDir::new().unwrap().path()).is_empty());
    }
}
