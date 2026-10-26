//! Project-scoped conversation snapshots, independent of the harness process.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use veistra_agent_host::{event::ItemKind, Attachment, Harness, Item};
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS};

const MAX_BYTES: u64 = 16 * 1024 * 1024;

/// All snapshots are app data, never files written into the user's checkout.
#[derive(Default)]
pub(super) struct History {
    active: Mutex<HashMap<String, (String, String)>>,
    writing: Mutex<()>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Saved {
    pub id: String,
    pub project: String,
    pub title: String,
    pub updated: u64,
    pub harness: Harness,
    pub archived: bool,
    pub items: Vec<Item>,
}

fn error(e: impl std::fmt::Display) -> RpcError {
    RpcError::new(
        INTERNAL_ERROR,
        format!("Could not save or read conversation history: {e}"),
    )
}

fn project_key(project: &Path) -> Result<String, RpcError> {
    let value = project
        .canonicalize()
        .map_err(error)?
        .to_string_lossy()
        .into_owned();
    Ok(if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    })
}

fn file(dir: &Path, id: &str) -> Result<PathBuf, RpcError> {
    if id.len() != 48 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(RpcError::new(INVALID_PARAMS, "Invalid conversation id"));
    }
    Ok(dir.join(format!("{id}.json")))
}

fn new_id() -> String {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    format!(
        "{:032x}{:08x}{:08x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn read(dir: &Path, id: &str, project: &str) -> Result<Saved, RpcError> {
    let path = file(dir, id)?;
    if std::fs::metadata(&path).map_err(error)?.len() > MAX_BYTES {
        return Err(error("Conversation snapshot is too large"));
    }
    let saved: Saved =
        serde_json::from_slice(&std::fs::read(path).map_err(error)?).map_err(error)?;
    if saved.project != project || saved.id != id {
        return Err(RpcError::new(
            INVALID_PARAMS,
            "That conversation belongs to another project",
        ));
    }
    Ok(saved)
}

fn write(dir: &Path, saved: &Saved) -> Result<(), RpcError> {
    let bytes = serde_json::to_vec(saved).map_err(error)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(error("Conversation snapshot is too large"));
    }
    std::fs::create_dir_all(dir).map_err(error)?;
    let path = file(dir, &saved.id)?;
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, bytes).map_err(error)?;
    std::fs::rename(&temp, &path).map_err(error)
}

/// An accepted prompt is already part of the conversation while the harness starts.
fn include_pending(mut items: Vec<Item>, pending: Option<&str>) -> Vec<Item> {
    if let Some(text) = pending {
        items.push(Item {
            id: "history-pending".into(),
            turn_id: "history-pending".into(),
            kind: ItemKind::UserMessage { text: text.into() },
        });
    }
    items
}

impl History {
    /// Save only host-owned transcript data; the frame cannot forge saved messages.
    pub fn save(
        &self,
        dir: &Path,
        instance: &str,
        project: &Path,
        harness: Harness,
        attachment: Attachment,
    ) -> Result<(), RpcError> {
        let items = include_pending(
            attachment.items,
            attachment
                .status
                .as_ref()
                .and_then(|s| s.pending_prompt.as_deref()),
        );
        if items.is_empty() {
            return Ok(());
        }
        let _writing = self.writing.lock().unwrap_or_else(|e| e.into_inner());
        let project = project_key(project)?;
        let id = {
            let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
            let entry = active
                .entry(instance.to_string())
                .or_insert_with(|| (project.clone(), new_id()));
            if entry.0 != project {
                *entry = (project.clone(), new_id());
            }
            entry.1.clone()
        };
        let title = items
            .iter()
            .find_map(|i| match &i.kind {
                ItemKind::UserMessage { text } => Some(
                    text.split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .chars()
                        .take(100)
                        .collect(),
                ),
                _ => None,
            })
            .unwrap_or_else(|| "Conversation".to_string());
        let archived = read(dir, &id, &project)
            .map(|s| s.archived)
            .unwrap_or(false);
        write(
            dir,
            &Saved {
                id,
                project,
                title,
                harness,
                archived,
                updated: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                items,
            },
        )
    }

    /// A new conversation gets its own snapshot instead of overwriting the old one.
    pub fn forget(&self, instance: &str) {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(instance);
    }

    pub fn list(&self, dir: &Path, project: &Path) -> Result<serde_json::Value, RpcError> {
        let project = project_key(project)?;
        if !dir.exists() {
            return Ok(serde_json::json!({ "sessions": [] }));
        }
        let mut saved = Vec::new();
        for entry in std::fs::read_dir(dir).map_err(error)? {
            let entry = entry.map_err(error)?;
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Some(id) = entry
                .path()
                .file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_string)
            else {
                continue;
            };
            if let Ok(session) = read(dir, &id, &project) {
                saved.push(session);
            }
        }
        saved.sort_by_key(|s| std::cmp::Reverse(s.updated));
        let sessions: Vec<_> = saved.into_iter().map(|s| serde_json::json!({ "id": s.id, "title": s.title, "updated": s.updated, "harness": s.harness, "archived": s.archived })).collect();
        Ok(serde_json::json!({ "sessions": sessions }))
    }

    pub fn load(&self, dir: &Path, project: &Path, id: &str) -> Result<Saved, RpcError> {
        read(dir, id, &project_key(project)?)
    }

    pub fn select(&self, instance: &str, saved: &Saved) {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                instance.to_string(),
                (saved.project.clone(), saved.id.clone()),
            );
    }

    pub fn archive(
        &self,
        dir: &Path,
        project: &Path,
        id: &str,
        archived: bool,
    ) -> Result<(), RpcError> {
        let _writing = self.writing.lock().unwrap_or_else(|e| e.into_inner());
        let mut saved = self.load(dir, project, id)?;
        saved.archived = archived;
        write(dir, &saved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use veistra_agent_host::event::ItemKind;

    #[test]
    fn a_prompt_waiting_for_startup_is_kept_in_history() {
        let items = include_pending(vec![], Some("Start the project"));
        assert!(
            matches!(&items[0].kind, ItemKind::UserMessage {text} if text == "Start the project")
        );
        assert!(include_pending(vec![], None).is_empty());
    }

    #[test]
    fn history_survives_new_conversations_and_is_project_scoped() {
        let root = std::env::temp_dir().join(format!("agent-history-{}", new_id()));
        let other = root.join("other");
        std::fs::create_dir_all(&other).unwrap();
        let dir = root.join("saved");
        let history = History::default();
        let attachment = Attachment {
            seq: 1,
            status: None,
            items: vec![Item {
                id: "i".into(),
                turn_id: "t".into(),
                kind: ItemKind::UserMessage {
                    text: "Fix the agent UI".into(),
                },
            }],
        };
        history
            .save(&dir, "tab", &root, Harness::Claude, attachment.clone())
            .unwrap();
        let list = history.list(&dir, &root).unwrap();
        let id = list["sessions"][0]["id"].as_str().unwrap();
        assert_eq!(list["sessions"][0]["title"], "Fix the agent UI");
        assert!(history.load(&dir, &other, id).is_err());
        assert!(history.load(&dir, &root, "../escape").is_err());
        history.archive(&dir, &root, id, true).unwrap();
        assert!(history.load(&dir, &root, id).unwrap().archived);
        history.forget("tab");
        history
            .save(&dir, "tab", &root, Harness::Codex, attachment)
            .unwrap();
        assert_eq!(
            history.list(&dir, &root).unwrap()["sessions"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            History::default().list(&dir, &root).unwrap()["sessions"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
