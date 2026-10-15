//! What somebody wrote on an element in Design Mode, kept where an agent can
//! read it.
//!
//! Design Mode used to end at the clipboard: pick an element, copy a wall of
//! Markdown and a picture, paste both into an agent. That works in a chat
//! window and nowhere else — an agent in a terminal cannot be pasted an image,
//! and a person with six changes to ask for cannot paste six times and keep
//! track of which one is done.
//!
//! This is the store that replaces it. A comment is the user's request against
//! one captured element; it has an id that outlives the app, a status that says
//! whose turn it is, and a thread the two sides take turns in.
//! `mcp::servers::design` serves the same records to whatever agent is running
//! in a terminal, so the handoff is a tool call rather than a paste.
//!
//! `docs/design-notes/design-comments.md` is the long form — the state machine,
//! why the server that reads this one is allowed to write, and what was
//! rejected on the way.

use crate::sync::RwLockExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const FILE: &str = "design-comments.json";

/// Where a comment's screenshot goes, under the config directory.
const SHOTS: &str = "design-shots";

/// How many resolved comments are kept before the oldest are forgotten.
///
/// Resolved comments are kept at all because "what did I already ask for" is a
/// real question, and a store that empties itself the moment work finishes
/// cannot answer it. They are capped because nothing else would ever delete
/// one, and an append-only file behind a text box is a file that grows for as
/// long as the app is used.
const KEPT_RESOLVED: usize = 200;

/// Whose turn it is.
///
/// Three states rather than two, because "the agent needs something from me" is
/// not the same as "nobody has looked at this yet", and an app that draws them
/// the same way is one where a question sits unanswered forever. A user's reply
/// to a [`Status::Question`] puts the comment back to [`Status::Open`]: the
/// agent is owed a turn again, and that is exactly what open means.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// The agent's turn: act on it, ask about it, or resolve it.
    Open,
    /// The user's turn: the agent asked something and is waiting.
    Question,
    /// Done. Kept for a while, then forgotten — see [`KEPT_RESOLVED`].
    Resolved,
}

impl Status {
    /// Whether this comment is still part of the conversation.
    ///
    /// The word the MCP server's tool description uses, so it is defined once
    /// here rather than as a `!= Resolved` at each of the places that filters.
    pub fn active(self) -> bool {
        self != Status::Resolved
    }
}

/// Who said a thing.
///
/// Deliberately two values and not a name. Nothing here has accounts, and a
/// thread only has to answer "is this mine or the machine's" for either side to
/// read it correctly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Author {
    User,
    Agent,
}

/// One turn in a comment's thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Remark {
    pub author: Author,
    pub text: String,
    /// Milliseconds since the epoch. A number rather than a formatted string,
    /// because the two readers of this file format a time differently and
    /// neither should be parsing the other's choice back out.
    pub at: u64,
}

/// Where an element was, in the page's own viewport.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The element the comment is about, as the probe described it.
///
/// A copy rather than a reference to a live page, and that is the point: the
/// dev server will have restarted and the markup will have changed by the time
/// an agent reads this. What the user was looking at when they wrote the
/// sentence is the thing worth keeping.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Element {
    pub tag: String,
    pub selector: String,
    pub ancestors: String,
    pub text: String,
    pub html: String,
    pub attributes: BTreeMap<String, String>,
    pub styles: BTreeMap<String, String>,
    pub rect: Rect,
}

/// Which page the element was on. Query and fragment are already stripped by
/// the probe, so two comments left on the same screen group together.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Page {
    pub url: String,
    pub title: String,
}

/// One comment: an element, a request, and the conversation about it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub status: Status,
    pub page: Page,
    pub element: Element,
    /// What the user asked for, as first written. Kept out of [`thread`] and
    /// never edited: it is the thing every later turn is about, and a request
    /// that scrolled off the top of a conversation is a request an agent stops
    /// answering.
    ///
    /// [`thread`]: Comment::thread
    pub request: String,
    /// Every turn after the request, oldest first.
    pub thread: Vec<Remark>,
    pub created: u64,
    pub updated: u64,
    /// Whether a picture of the element was stored beside this record.
    ///
    /// A flag rather than the bytes. Listing every comment is the common call
    /// and it must not read a megabyte of PNG per row to answer; the picture is
    /// fetched by id when something actually wants it.
    pub has_shot: bool,
}

/// A new comment, before it has an id or a clock reading.
///
/// No `has_shot`: whether a picture was stored is not something a caller may
/// assert, because the caller does not know the id the file will be named for.
/// [`Comments::add`] takes the bytes and sets the flag from whether the write
/// worked, so the two can never disagree.
#[derive(Debug, Clone, Default)]
pub struct Draft {
    pub page: Page,
    pub element: Element,
    pub request: String,
}

/// Everything on disk: the comments, and the counter that names the next one.
///
/// The counter is persisted rather than derived from the highest id present.
/// Deriving it would reuse the id of a comment that had been forgotten, and a
/// reused id is worse than a gap — an agent holding `c7` from an earlier
/// session would resolve somebody else's request and report success.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Book {
    pub next: u64,
    pub comments: Vec<Comment>,
}

/// Every comment this machine holds, shared by every window.
///
/// Process-wide rather than per-frame, unlike everything else in Design Mode.
/// Two Design Mode tabs pointed at the same dev server are two views of one
/// list of requests, and an agent asking "what is outstanding" is not asking
/// about a tab.
#[derive(Default)]
pub struct Comments {
    book: RwLock<Book>,
}

/// The id given to the `n`th comment ever written on this machine.
///
/// Short and typeable, because it is what a model writes back into
/// `resolve_comment` and what a person reads in a list. Rejected: a random hex
/// id, which is what the first draft had. Uniqueness is already guaranteed by a
/// persisted counter in a single-instance application, so the twelve extra
/// characters bought nothing and cost a transcription error every time somebody
/// typed one.
fn name(n: u64) -> String {
    format!("c{n}")
}

/// Now, in milliseconds since the epoch, or zero on a machine whose clock is
/// set before 1970.
///
/// Zero rather than a failure: a timestamp orders a thread and nothing more, and
/// refusing to record a comment because the clock is wrong would be a worse
/// answer than recording it with a wrong time.
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default()
}

impl Book {
    /// Take the next id, before there is a comment to give it to.
    ///
    /// Split from [`push`](Book::push) because a comment's picture is named for
    /// its id and has to be on disk before the record can claim to have one.
    /// Reserving first means the file write happens between the two, outside the
    /// lock, rather than under it.
    fn reserve(&mut self) -> String {
        self.next += 1;
        name(self.next)
    }

    /// Store a comment under an id [`reserve`](Book::reserve) handed out.
    fn push(&mut self, id: String, draft: Draft, has_shot: bool) -> Comment {
        let at = now();
        let comment = Comment {
            id,
            status: Status::Open,
            page: draft.page,
            element: draft.element,
            request: draft.request,
            thread: Vec::new(),
            created: at,
            updated: at,
            has_shot,
        };

        self.comments.push(comment.clone());
        comment
    }

    /// Add a turn to one comment's thread and move it to `status`.
    ///
    /// One function for all four verbs — the user replying, the agent
    /// answering, the agent asking, either side resolving — because they differ
    /// only in who is speaking and where the turn leaves the comment. Four
    /// near-identical functions is how two of them end up forgetting to touch
    /// `updated`.
    fn say(&mut self, id: &str, author: Author, text: &str, status: Status) -> Option<Comment> {
        // One reading of the clock, so the remark and the comment's `updated`
        // cannot disagree by whatever the two calls cost.
        let at = now();
        let comment = self.comments.iter_mut().find(|c| c.id == id)?;
        comment.thread.push(Remark {
            author,
            text: text.to_string(),
            at,
        });
        comment.status = status;
        comment.updated = at;
        Some(comment.clone())
    }

    /// Drop one comment outright. `true` if there was one to drop.
    fn remove(&mut self, id: &str) -> bool {
        let before = self.comments.len();
        self.comments.retain(|c| c.id != id);
        before != self.comments.len()
    }

    /// Forget the oldest resolved comments past [`KEPT_RESOLVED`], and say which
    /// ids went, so their screenshots can go with them.
    ///
    /// Only resolved ones are ever candidates. An open comment is somebody's
    /// outstanding request and no cap may quietly delete one, however many of
    /// them there are.
    fn prune(&mut self) -> Vec<String> {
        let resolved: Vec<String> = self
            .comments
            .iter()
            .filter(|c| c.status == Status::Resolved)
            .map(|c| c.id.clone())
            .collect();

        if resolved.len() <= KEPT_RESOLVED {
            return Vec::new();
        }

        let dropped: Vec<String> = resolved[..resolved.len() - KEPT_RESOLVED].to_vec();
        self.comments.retain(|c| !dropped.contains(&c.id));
        dropped
    }
}

impl Comments {
    /// Every comment, oldest first.
    ///
    /// Written order, not display order. An agent works through a list from the
    /// top and should meet the oldest request first; the app draws the newest
    /// first, and sorts for itself rather than being handed one of the two
    /// orders and having to undo it.
    pub fn all(&self) -> Vec<Comment> {
        self.book.read_or_panic().comments.clone()
    }

    /// One comment by id.
    pub fn get(&self, id: &str) -> Option<Comment> {
        self.book
            .read_or_panic()
            .comments
            .iter()
            .find(|c| c.id == id)
            .cloned()
    }

    /// Write a comment down, with its picture, and persist the book.
    ///
    /// A picture that will not write leaves a comment that says it has none.
    /// The alternative — failing the whole call — would lose the sentence over
    /// the half of the capture an agent can least act on.
    pub fn add(&self, app: &AppHandle, draft: Draft, png: Option<&[u8]>) -> Comment {
        let id = self.book.write_or_panic().reserve();
        let has_shot = png.is_some_and(|bytes| save_shot(app, &id, bytes));

        let (comment, dropped) = {
            let mut book = self.book.write_or_panic();
            let comment = book.push(id, draft, has_shot);
            (comment, book.prune())
        };

        for gone in dropped {
            remove_shot(app, &gone);
        }
        self.persist(app);
        comment
    }

    /// Add a turn to a thread. `None` when no comment has that id, which the
    /// callers turn into the error a client sees.
    pub fn say(
        &self,
        app: &AppHandle,
        id: &str,
        author: Author,
        text: &str,
        status: Status,
    ) -> Option<Comment> {
        let changed = self.book.write_or_panic().say(id, author, text, status);
        if changed.is_some() {
            self.persist(app);
        }
        changed
    }

    /// Drop a comment and its picture.
    pub fn remove(&self, app: &AppHandle, id: &str) -> bool {
        let removed = self.book.write_or_panic().remove(id);
        if removed {
            remove_shot(app, id);
            self.persist(app);
        }
        removed
    }

    /// Put back what was on disk at launch.
    pub fn hydrate(&self, app: &AppHandle) {
        *self.book.write_or_panic() = load(app);
    }

    fn persist(&self, app: &AppHandle) {
        save(app, &self.book.read_or_panic());
    }
}

/// Read the store, or start empty. Never fails, on the rule every store in this
/// crate follows: a machine that will not hand this file back is one where
/// Design Mode should still open, minus its history.
fn load(app: &AppHandle) -> Book {
    let Some(path) = file(app) else {
        return Book::default();
    };

    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                crate::kaava_log!("could not read {}: {e}", path.display());
            }
            return Book::default();
        }
    };

    serde_json::from_str(&raw).unwrap_or_else(|e| {
        crate::kaava_log!("{} is not readable, starting empty: {e}", path.display());
        Book::default()
    })
}

/// Write the store, atomically — temp file then rename, so a reader never sees
/// half of each of two launches.
fn save(app: &AppHandle, book: &Book) {
    let Some(path) = file(app) else { return };

    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            crate::kaava_log!("could not create {}: {e}", parent.display());
            return;
        }
    }

    let json = match serde_json::to_string_pretty(book) {
        Ok(json) => json,
        Err(e) => {
            crate::kaava_log!("could not serialize the design comments: {e}");
            return;
        }
    };

    let temp = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&temp, json) {
        crate::kaava_log!("could not write {}: {e}", temp.display());
        return;
    }
    if let Err(e) = std::fs::rename(&temp, &path) {
        crate::kaava_log!("could not replace {}: {e}", path.display());
        let _ = std::fs::remove_file(&temp);
    }
}

/// `%APPDATA%/<identifier>/design-comments.json` on Windows, the equivalent
/// elsewhere. Beside `settings.json` and never inside a project: a comment is
/// about a page somebody is looking at, which is not the same thing as a
/// checkout, and a file that appeared in a repository because somebody clicked
/// a button would be a file they had to decide whether to commit.
fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}

/// Where a comment's picture lives.
///
/// One file per comment rather than base64 inside the JSON. A screenshot is
/// hundreds of kilobytes and the JSON is rewritten on every reply, so inlining
/// one would mean rewriting every picture in the store to record a sentence.
pub(crate) fn shot_file(app: &AppHandle, id: &str) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(SHOTS).join(format!("{id}.png")))
}

/// Store a picture beside a comment. `false` if it could not be written, which
/// [`Comments::add`] records as a comment with no picture rather than as a
/// failure to leave a comment.
fn save_shot(app: &AppHandle, id: &str, png: &[u8]) -> bool {
    let Some(path) = shot_file(app, id) else {
        return false;
    };

    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            crate::kaava_log!("could not create {}: {e}", parent.display());
            return false;
        }
    }

    match std::fs::write(&path, png) {
        Ok(()) => true,
        Err(e) => {
            crate::kaava_log!("could not write {}: {e}", path.display());
            false
        }
    }
}

/// Read a comment's picture back.
pub fn read_shot(app: &AppHandle, id: &str) -> Option<Vec<u8>> {
    std::fs::read(shot_file(app, id)?).ok()
}

/// Delete a comment's picture, if it has one. Failure is ignored: the record it
/// belonged to is already gone, and a leftover PNG costs disk and nothing else.
fn remove_shot(app: &AppHandle, id: &str) {
    if let Some(path) = shot_file(app, id) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What [`Comments::add`] does either side of the file write, in one call —
    /// the two halves only exist so that the picture can land between them.
    fn add(book: &mut Book, request: &str) -> Comment {
        let id = book.reserve();
        book.push(id, draft(request), false)
    }

    fn draft(request: &str) -> Draft {
        Draft {
            page: Page {
                url: "http://localhost:5173/".to_string(),
                title: "Home".to_string(),
            },
            element: Element {
                tag: "button".to_string(),
                selector: ".cta".to_string(),
                ..Element::default()
            },
            request: request.to_string(),
        }
    }

    #[test]
    fn a_new_comment_is_open_and_carries_what_was_captured() {
        let mut book = Book::default();
        let comment = add(&mut book, "make this bigger");

        assert_eq!(comment.status, Status::Open);
        assert_eq!(comment.request, "make this bigger");
        assert_eq!(comment.element.selector, ".cta");
        assert!(comment.thread.is_empty());
        assert_eq!(book.comments.len(), 1);
    }

    /// Ids come off a persisted counter, so a comment that has been forgotten
    /// does not hand its name to a later one. An agent holding `c1` from an
    /// earlier session would otherwise resolve somebody else's request.
    #[test]
    fn ids_are_sequential_and_never_reused() {
        let mut book = Book::default();
        let first = add(&mut book, "one");
        let second = add(&mut book, "two");
        assert_eq!(first.id, "c1");
        assert_eq!(second.id, "c2");

        assert!(book.remove("c2"));
        let third = add(&mut book, "three");
        assert_eq!(third.id, "c3", "c2 must not come back");
    }

    #[test]
    fn a_thread_records_who_said_what_in_order() {
        let mut book = Book::default();
        add(&mut book, "make this bigger");

        book.say("c1", Author::Agent, "how much bigger?", Status::Question);
        book.say("c1", Author::User, "twice", Status::Open);

        let comment = book.comments[0].clone();
        assert_eq!(comment.thread.len(), 2);
        assert_eq!(comment.thread[0].author, Author::Agent);
        assert_eq!(comment.thread[0].text, "how much bigger?");
        assert_eq!(comment.thread[1].author, Author::User);
        assert_eq!(comment.status, Status::Open);
    }

    /// The turn-taking the three states exist for: a question is the user's to
    /// answer, and answering it hands the comment back to the agent.
    #[test]
    fn asking_waits_on_the_user_and_a_reply_hands_it_back() {
        let mut book = Book::default();
        add(&mut book, "tighten this");

        let asked = book
            .say("c1", Author::Agent, "which side?", Status::Question)
            .expect("the comment exists");
        assert_eq!(asked.status, Status::Question);
        assert!(asked.status.active(), "a question is still outstanding");

        let replied = book
            .say("c1", Author::User, "the left", Status::Open)
            .expect("the comment exists");
        assert_eq!(replied.status, Status::Open);
    }

    #[test]
    fn resolving_takes_a_comment_out_of_the_active_set() {
        let mut book = Book::default();
        add(&mut book, "tighten this");
        let done = book
            .say(
                "c1",
                Author::Agent,
                "done — padding halved",
                Status::Resolved,
            )
            .expect("the comment exists");

        assert_eq!(done.status, Status::Resolved);
        assert!(!done.status.active());
        assert_eq!(done.thread.last().map(|r| r.author), Some(Author::Agent));
    }

    /// A tool call naming an id nobody wrote has to be distinguishable from one
    /// that worked, or an agent reports having resolved a comment it never
    /// found.
    #[test]
    fn speaking_to_an_unknown_id_says_so() {
        let mut book = Book::default();
        add(&mut book, "one");
        assert!(book
            .say("c99", Author::Agent, "done", Status::Resolved)
            .is_none());
        assert!(!book.remove("c99"));
    }

    /// The request is what every later turn is about, so nothing appended to
    /// the thread may move it.
    #[test]
    fn the_original_request_survives_the_conversation() {
        let mut book = Book::default();
        add(&mut book, "make this bigger");
        book.say("c1", Author::Agent, "how much?", Status::Question);
        book.say("c1", Author::User, "twice", Status::Open);
        book.say("c1", Author::Agent, "done", Status::Resolved);

        assert_eq!(book.comments[0].request, "make this bigger");
    }

    /// The cap may only ever take resolved comments. An outstanding request is
    /// somebody's, and no amount of history is a reason to delete one.
    #[test]
    fn pruning_forgets_old_resolved_comments_and_never_an_open_one() {
        let mut book = Book::default();
        for n in 0..KEPT_RESOLVED + 10 {
            let comment = add(&mut book, &format!("request {n}"));
            book.say(&comment.id, Author::Agent, "done", Status::Resolved);
        }
        let open = add(&mut book, "still outstanding");

        let dropped = book.prune();
        assert_eq!(dropped.len(), 10);
        assert_eq!(dropped[0], "c1", "the oldest resolved goes first");

        let resolved = book
            .comments
            .iter()
            .filter(|c| c.status == Status::Resolved)
            .count();
        assert_eq!(resolved, KEPT_RESOLVED);
        assert!(book.comments.iter().any(|c| c.id == open.id));
    }

    #[test]
    fn a_store_under_the_cap_is_left_alone() {
        let mut book = Book::default();
        add(&mut book, "one");
        book.say("c1", Author::Agent, "done", Status::Resolved);
        assert!(book.prune().is_empty());
        assert_eq!(book.comments.len(), 1);
    }

    /// The round trip the file exists for. A comment that does not read back is
    /// a comment that vanishes when the app is restarted, which is the failure
    /// the clipboard version at least did not have.
    #[test]
    fn a_book_survives_a_round_trip_through_the_file_format() {
        let mut book = Book::default();
        add(&mut book, "make this bigger");
        book.say("c1", Author::Agent, "how much?", Status::Question);

        let json = serde_json::to_string_pretty(&book).expect("serializes");
        let back: Book = serde_json::from_str(&json).expect("and reads back");

        assert_eq!(back, book);
        assert_eq!(back.next, 1);
    }

    /// A file written by a later build must not take the comments in it down
    /// with the field this build does not know about.
    #[test]
    fn an_unknown_field_does_not_fail_the_read() {
        let book: Book = serde_json::from_str(r#"{"next":2,"comments":[],"pinnedByPolicy":true}"#)
            .expect("an unknown field is ignored");
        assert_eq!(book.next, 2);
    }

    #[test]
    fn an_empty_document_is_an_empty_book() {
        let book: Book = serde_json::from_str("{}").expect("`{}` is an empty book");
        assert_eq!(book.next, 0);
        assert!(book.comments.is_empty());
    }

    /// The wire spelling is what both the frontend and the MCP client read, so
    /// a rename here is a breaking change and worth a test that fails loudly.
    #[test]
    fn statuses_and_authors_serialize_as_the_words_both_readers_expect() {
        assert_eq!(
            serde_json::to_string(&Status::Question).ok(),
            Some("\"question\"".to_string())
        );
        assert_eq!(
            serde_json::to_string(&Status::Resolved).ok(),
            Some("\"resolved\"".to_string())
        );
        assert_eq!(
            serde_json::to_string(&Author::Agent).ok(),
            Some("\"agent\"".to_string())
        );
    }
}
