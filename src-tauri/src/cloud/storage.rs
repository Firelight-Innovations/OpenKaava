//! Cloud Storage: list one level of a bucket, and download one object.
//!
//! `docs/cloud-services.md` §3 and §8 set the rules this follows. Listing goes
//! one level at a time or one known prefix at a time, never the whole bucket.
//! Metadata comes before content: a caller compares `generation` against
//! [`Cache`] and downloads only what changed.

use super::http::{self, Verb};
use super::{rfc3339, Cloud, Result, Source, Trouble};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// One object's metadata, as the list call returns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Object {
    pub name: String,
    pub generation: i64,
    pub updated: String,
    pub size: u64,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Listing {
    /// With a delimiter, the "folders" one level down, each ending in `/`.
    pub prefixes: Vec<String>,
    pub objects: Vec<Object>,
}

/// Downloaded bytes and the generation they belong to.
pub struct Content {
    pub bytes: Vec<u8>,
    pub generation: i64,
    /// Only the last `tail` bytes were fetched, because the object is longer.
    pub truncated: bool,
}

/// Parsed JSON objects keyed by `bucket/object`, each with its generation.
/// A poll that sees the same generation reuses the parse instead of
/// downloading again.
#[derive(Default)]
pub struct Cache {
    json: Mutex<HashMap<String, (i64, Value)>>,
}

impl Cache {
    pub fn get(&self, key: &str, generation: i64) -> Option<Value> {
        let map = self.json.lock().unwrap_or_else(|e| e.into_inner());
        map.get(key)
            .filter(|(g, _)| *g == generation)
            .map(|(_, v)| v.clone())
    }

    pub fn put(&self, key: String, generation: i64, value: Value) {
        let mut map = self.json.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(key, (generation, value));
    }
}

/// One page-through of `prefix`. `delimiter` lists one level only.
pub fn list(
    cloud: &Cloud,
    source: &Source,
    bucket: &str,
    prefix: &str,
    delimiter: bool,
) -> Result<Listing> {
    match source {
        Source::Live { .. } => list_live(cloud, bucket, prefix, delimiter),
        Source::Fixture { root } => list_fixture(root, bucket, prefix, delimiter),
    }
}

/// Download `object`. With `tail`, only its last `tail` bytes.
pub fn read(
    cloud: &Cloud,
    source: &Source,
    bucket: &str,
    object: &Object,
    tail: Option<u64>,
) -> Result<Content> {
    let truncated = tail.is_some_and(|t| object.size > t);
    match source {
        Source::Live { .. } => {
            let url = format!(
                "https://storage.googleapis.com/storage/v1/b/{}/o/{}?alt=media&generation={}",
                http::encode(bucket),
                http::encode(&object.name),
                object.generation
            );
            let range = truncated.then(|| format!("bytes=-{}", tail.unwrap_or(0)));
            let reply = http::send(
                &cloud.tokens,
                Verb::Get,
                &url,
                &format!("gs://{bucket}/{}", object.name),
                range.as_deref(),
                tail.unwrap_or(object.size).max(1) + 1024,
            )?;
            Ok(Content {
                bytes: reply.body,
                generation: reply.generation.unwrap_or(object.generation),
                truncated,
            })
        }
        Source::Fixture { root } => {
            let path = fixture_path(root, bucket, &object.name)?;
            let mut bytes = std::fs::read(&path).map_err(|e| Trouble::Fixture {
                detail: format!("{}: {e}", path.display()),
            })?;
            if let (true, Some(t)) = (truncated, tail) {
                bytes = bytes.split_off(bytes.len() - t as usize);
            }
            Ok(Content {
                bytes,
                generation: object.generation,
                truncated,
            })
        }
    }
}

// --- live --------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    #[serde(default)]
    prefixes: Vec<String>,
    #[serde(default)]
    items: Vec<Item>,
    next_page_token: Option<String>,
}

/// Google sends `generation` and `size` as strings.
#[derive(Deserialize)]
struct Item {
    name: String,
    generation: String,
    updated: String,
    size: String,
}

fn list_live(cloud: &Cloud, bucket: &str, prefix: &str, delimiter: bool) -> Result<Listing> {
    let mut listing = Listing::default();
    let mut token: Option<String> = None;
    loop {
        let mut url = format!(
            "https://storage.googleapis.com/storage/v1/b/{}/o?prefix={}&fields=prefixes,items(name,generation,updated,size),nextPageToken",
            http::encode(bucket),
            http::encode(prefix)
        );
        if delimiter {
            url.push_str("&delimiter=%2F");
        }
        if let Some(t) = &token {
            url.push_str(&format!("&pageToken={}", http::encode(t)));
        }
        let reply = http::send(
            &cloud.tokens,
            Verb::Get,
            &url,
            &format!("gs://{bucket}"),
            None,
            16 << 20,
        )?;
        let page: Page = serde_json::from_slice(&reply.body).map_err(|e| Trouble::Api {
            status: 200,
            detail: format!("unreadable object list: {e}"),
        })?;
        listing.prefixes.extend(page.prefixes);
        listing
            .objects
            .extend(page.items.into_iter().map(|i| Object {
                name: i.name,
                generation: i.generation.parse().unwrap_or(0),
                updated: i.updated,
                size: i.size.parse().unwrap_or(0),
            }));
        match page.next_page_token {
            Some(t) if !t.is_empty() => token = Some(t),
            _ => return Ok(listing),
        }
    }
}

// --- fixture -----------------------------------------------------------------

fn fixture_path(root: &Path, bucket: &str, name: &str) -> Result<PathBuf> {
    let mut path = root.join(bucket);
    for part in name.split('/') {
        if !super::is_plain_segment(part) {
            return Err(Trouble::Fixture {
                detail: format!("refusing object name {name:?}"),
            });
        }
        path.push(part);
    }
    Ok(path)
}

fn list_fixture(root: &Path, bucket: &str, prefix: &str, delimiter: bool) -> Result<Listing> {
    let base = root.join(bucket);
    if !base.is_dir() {
        return Err(Trouble::Missing {
            what: format!("gs://{bucket}"),
        });
    }
    let mut all = Vec::new();
    walk(&base, "", &mut all);
    all.sort_by(|a, b| a.name.cmp(&b.name));

    let mut listing = Listing::default();
    for object in all.into_iter().filter(|o| o.name.starts_with(prefix)) {
        let rest = &object.name[prefix.len()..];
        match rest.find('/') {
            Some(cut) if delimiter => {
                let folder = format!("{prefix}{}", &rest[..=cut]);
                if listing.prefixes.last() != Some(&folder) {
                    listing.prefixes.push(folder);
                }
            }
            _ => listing.objects.push(object),
        }
    }
    listing.prefixes.dedup();
    Ok(listing)
}

fn walk(dir: &Path, prefix: &str, out: &mut Vec<Object>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = format!("{prefix}{}", entry.file_name().to_string_lossy());
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            walk(&entry.path(), &format!("{name}/"), out);
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .unwrap_or_default();
        out.push(Object {
            name,
            generation: i64::try_from(modified.as_micros()).unwrap_or(i64::MAX),
            updated: rfc3339(i64::try_from(modified.as_secs()).unwrap_or(0)),
            size: meta.len(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Source) {
        let dir = tempfile::tempdir().unwrap();
        for (name, body) in [
            ("b/agent-a/s1/status.json", "{}"),
            ("b/agent-a/s1/transcript.jsonl", "line\n"),
            ("b/agent-a/s2/status.json", "{}"),
            ("b/agent-b/s3/status.json", "{}"),
            ("b/top.txt", "0123456789"),
        ] {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
        let source = Source::Fixture {
            root: dir.path().to_path_buf(),
        };
        (dir, source)
    }

    #[test]
    fn a_delimited_list_returns_one_level() {
        let (_dir, source) = fixture();
        let listing = list(&Cloud::default(), &source, "b", "", true).unwrap();
        assert_eq!(listing.prefixes, vec!["agent-a/", "agent-b/"]);
        let names: Vec<_> = listing.objects.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(names, vec!["top.txt"]);
    }

    #[test]
    fn a_prefix_list_without_delimiter_returns_everything_under_it() {
        let (_dir, source) = fixture();
        let listing = list(&Cloud::default(), &source, "b", "agent-a/", false).unwrap();
        assert!(listing.prefixes.is_empty());
        assert_eq!(listing.objects.len(), 3);
    }

    #[test]
    fn a_missing_bucket_is_missing_not_empty() {
        let (_dir, source) = fixture();
        let err = list(&Cloud::default(), &source, "nope", "", true).unwrap_err();
        assert!(matches!(err, Trouble::Missing { .. }));
    }

    #[test]
    fn a_tail_read_returns_the_end_and_says_so() {
        let (_dir, source) = fixture();
        let cloud = Cloud::default();
        let listing = list(&cloud, &source, "b", "top", false).unwrap();
        let content = read(&cloud, &source, "b", &listing.objects[0], Some(4)).unwrap();
        assert_eq!(content.bytes, b"6789");
        assert!(content.truncated);
    }

    #[test]
    fn a_fixture_refuses_traversal() {
        let (_dir, source) = fixture();
        let object = Object {
            name: "../escape".into(),
            generation: 1,
            updated: String::new(),
            size: 1,
        };
        assert!(read(&Cloud::default(), &source, "b", &object, None).is_err());
    }

    #[test]
    fn the_cache_answers_only_for_the_same_generation() {
        let cache = Cache::default();
        cache.put("b/x".into(), 7, serde_json::json!({"a": 1}));
        assert!(cache.get("b/x", 7).is_some());
        assert!(cache.get("b/x", 8).is_none());
    }
}
