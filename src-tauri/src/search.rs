//! Content search: what the search overlay actually searches.
//!
//! The frontend's first cut (`src/shell/search/searchSource.ts`) walked a cluster's directory over
//! the Files app's `files/list` and matched only file *names* — an explicit placeholder, documented
//! as such in its own header. This is the real thing it was waiting on: a walk that also opens
//! every file and reports every line a query matches, with enough position information (line,
//! column, length) for find-and-replace to step through matches one at a time and for the preview
//! pane to highlight exactly the right span.
//!
//! Built from the same crates ripgrep is built from — `ignore` for the walk, `grep-regex` for the
//! matcher, `grep-searcher` to drive it over a file's bytes — rather than shelling out to an `rg`
//! binary the way `git.rs` shells out to `git`. Deliberate: `git` is on every developer's machine
//! already for its own reasons, `rg` is not, and this cannot depend on a tool nobody chose.
//!
//! Using `ignore` buys `.gitignore` support for free — the same walker VS Code's own search is
//! built on — which is what lets this module retire the old hardcoded `node_modules`/`dist`/
//! `target` skip list entirely rather than carry it forward beside a real ignore engine. Like
//! `git.rs`, every command here takes a cluster *id*, never a path — the frontend never gets to
//! name a directory for the backend to run a search in.

use crate::error::{AppError, Result};
use crate::settings::{self, keys};
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{sinks, BinaryDetection, SearcherBuilder};
use ignore::{WalkBuilder, WalkState};
use serde::Serialize;
use std::ffi::OsStr;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// One occurrence of the query inside a file, positioned for an editor to jump to it.
///
/// Mirrors `SearchMatch` in `src/shell/search/types.ts` field for field — that type's doc comments
/// are the authority on what each field means to the UI; this is only the wire shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line: u32,
    pub column: u32,
    pub text: String,
    pub length: u32,
}

/// One file worth of results.
///
/// `matches` is empty for a file that matched on its *name* only — the same
/// file-with-no-nested-rows case `SearchHit.matches` documents on the TypeScript side. Whether a
/// name matched at all is not carried as a separate field: a file with no name match and no
/// content matches is never turned into a `SearchFileHit`, so every hit that reaches the frontend
/// already deserves to be there.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileHit {
    /// Absolute, in whatever form `Path::display` gives on this platform — backslashes on Windows.
    /// Matches `apps/files.rs`, which is what the old name-only walk read its paths from; the
    /// preview pane and locator tree already expect this form, not git's forward-slash convention.
    pub path: String,
    pub matches: Vec<SearchMatch>,
}

/// Every hit the walk found, plus whether it stopped early.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub hits: Vec<SearchFileHit>,
    /// True when the match cap below cut the walk short, or a newer search superseded this one
    /// before it finished. Either way the result set is real but incomplete, and the UI must not
    /// present it as the whole answer — see `MAX_MATCHES` and `SearchState` for the two cases.
    pub truncated: bool,
}

/// The three limits one search enforces, read from settings once per search rather than baked in
/// as constants.
///
/// Read at the top of `search_content`'s blocking closure and threaded down by reference — never
/// re-read mid-walk, which would let a setting changed while a search is already running produce a
/// response that started under one budget and finished under another.
struct Caps {
    /// How many matches one search collects before it stops walking.
    ///
    /// A cap on *matches*, not files: a single generated file with the query on every line would
    /// otherwise produce a response of unbounded size from one hit. The default (1000,
    /// `search.maxMatches` in `settings::schema`) is generous enough that an ordinary "how is this
    /// function called" search never brushes it, and small enough that hitting it — some repo-wide
    /// token like a common word — returns in a search-as-you-type budget rather than after walking
    /// the whole tree.
    max_matches: usize,

    /// How many *files* one search reports, independent of `max_matches`.
    ///
    /// `max_matches` alone does not bound the response: a query that matches hundreds of file
    /// *names* but appears in no file's contents — `"test"` across a typical repo, say — never
    /// advances the match counter at all, so without a separate cap here the two limits would leave
    /// that one case unbounded. The default (500, `search.maxFiles`) still comfortably sits under
    /// `max_matches`'s default, since a single file is a handful of matches, not hundreds.
    max_files: usize,

    /// Files larger than this are still checked for a *name* match but never opened for a content
    /// one.
    ///
    /// A large file is disproportionately likely to be a bundle, a lockfile, or a data dump rather
    /// than something a search-as-you-type feature is aimed at, and scanning one line by line is
    /// the single most expensive thing this walk can do per file. The default (8 MiB,
    /// `search.maxFileSizeMb`) comfortably covers real source files — the generated ones this
    /// excludes are exactly the ones nobody is searching by hand.
    max_content_bytes: u64,

    /// How long one search may walk before it returns what it has, marked truncated.
    time_budget: Duration,
}

impl Caps {
    fn read(app: &AppHandle) -> Self {
        Self {
            max_matches: settings::number(app, keys::SEARCH_MAX_MATCHES).max(1) as usize,
            max_files: settings::number(app, keys::SEARCH_MAX_FILES).max(1) as usize,
            max_content_bytes: mb_to_bytes(settings::number(app, keys::SEARCH_MAX_FILE_SIZE_MB)),
            time_budget: SEARCH_TIME_BUDGET,
        }
    }
}

/// The longest one search walks. Long enough for a warm tree of any ordinary size to finish, short
/// enough that a cold or huge one answers while the person is still looking at the dialog.
const SEARCH_TIME_BUDGET: Duration = Duration::from_secs(5);

/// A setting in megabytes, as the control draws it, converted to the bytes the walk actually
/// compares against. `.max(1)` before the multiply rather than after: a stored `0` or a negative
/// value — neither reachable through the control, both reachable through a hand-edited settings
/// file — must still yield a positive cap rather than one that skips every file.
fn mb_to_bytes(mb: i64) -> u64 {
    (mb.max(1) as u64) * 1024 * 1024
}

/// The single counter that makes an in-flight search abandon itself the moment a newer one starts.
///
/// There is no id round-trip from the frontend and no separate "cancel" command — `search_content`
/// bumps this counter itself, on the async side, before the walk (which runs on a blocking worker,
/// see the command's own doc comment) ever starts. The walk then checks, once per directory entry,
/// whether the counter still reads its own value; the moment it does not, some later call has
/// already started and this one has nothing left to contribute, so it stops rather than spending
/// more of the blocking thread pool on a result nobody will read.
///
/// This is coarser than per-search cancellation would be — a search anywhere in OpenKaava invalidates
/// a search anywhere else — but the search overlay is a single session shared by one window
/// (`useSearchSession.ts`), so "newest search wins" is already the exact rule the frontend enforces
/// with its own `AbortController`. One counter mirrors it without inventing a second cancellation
/// vocabulary.
///
/// `u64` rather than something smaller: this increments once per keystroke a user pauses on, for
/// as long as the app runs, and a `u32` is not obviously safe against wrapping over a long session.
#[derive(Default)]
pub struct SearchState {
    generation: AtomicU64,
}

impl SearchState {
    /// Claim the current generation and report it as "the one in progress". The value returned is
    /// what the walk must keep checking against.
    fn begin(&self) -> u64 {
        // `Ordering::SeqCst` rather than a weaker ordering: this is one atomic read-modify-write a
        // debounce cycle, not a hot loop, so there is nothing to gain from reasoning about a
        // cheaper ordering and real cost to getting it wrong.
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Whether `generation` is still the most recent one claimed.
    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }
}

/// Search a cluster's directory for `query`, both in file names and in file contents, and report
/// every match.
///
/// Why this is `async` and hops to a worker: a `#[tauri::command]` that is a plain synchronous
/// function runs on the **main thread** — the same one driving every window's UI.
/// `commands::app_call`'s doc comment lays out the failure mode this avoids: a filesystem walk of
/// any real size would freeze every OpenKaava window for as long as it took.
/// `tauri::async_runtime::spawn_blocking` moves the walk to a worker thread and this command
/// `.await`s it, the same shape `app_call` already uses for exactly this reason.
///
/// Why the generation is claimed before the hop and not inside it: `SearchState::begin` runs
/// synchronously, before `spawn_blocking` is even called, so two `search_content` invocations keep
/// the order the frontend made them in. Claiming it inside the worker would let two blocking-pool
/// threads race for it, and whichever happened to be scheduled second would — correctly by its own
/// logic, wrongly for the user — invalidate the newer search.
///
/// `case_sensitive`, `whole_word`, and `regex` all apply to *both* halves of the search — a file's
/// name and its contents are matched with the one matcher built from them, so "case-insensitive"
/// cannot mean one thing for `README` and another for a line inside it.
#[tauri::command]
pub async fn search_content(
    app: AppHandle,
    cluster_id: String,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
) -> Result<SearchResponse> {
    let generation = app.state::<SearchState>().begin();

    tauri::async_runtime::spawn_blocking(move || {
        let Some(root) = crate::project::cluster_path(&app, &cluster_id) else {
            // No project, or the project's folder is gone — the same "nothing to search" state
            // `git_cluster_status` draws as empty rather than as an error.
            return Ok(SearchResponse {
                hits: Vec::new(),
                truncated: false,
            });
        };

        let matcher = build_matcher(&query, case_sensitive, whole_word, regex)?;
        let state = app.state::<SearchState>();
        // Read once, here, rather than inside `walk`'s per-entry loop — a `settings::number` call
        // is a mutex lock per key, and the loop below runs once per directory entry.
        let caps = Caps::read(&app);

        Ok(walk(
            &root,
            &matcher,
            &|| state.is_current(generation),
            &caps,
        ))
    })
    .await
    // The worker panicked or the runtime is shutting down — `app_call`'s own comment on the
    // identical `.unwrap_or_else` explains why this becomes a plain error rather than an unwrap
    // that would take the main thread with it. No `RpcError` vocabulary here, so it crosses as an
    // ordinary `AppError`.
    .unwrap_or_else(|e| {
        Err(AppError::Search(format!(
            "the search did not complete: {e}"
        )))
    })
}

/// A query plus its three flags, compiled into one matcher that both the name check and the
/// content scan below reuse.
///
/// `regex: false` does not mean "skip the regex engine" — `grep-regex` is a regex engine start to
/// finish, including for a literal query. It means "escape the query first", via
/// `regex_syntax::escape`, so that a search for `a.b()` looks for those five characters rather than
/// "any character, b, then a captured empty group". Building a literal search this way rather than
/// hand-writing a byte comparison is what lets `whole_word` — itself a regex word-boundary
/// wrapper — apply uniformly to both modes.
fn build_matcher(
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
) -> Result<grep_regex::RegexMatcher> {
    let pattern = if regex {
        query.to_string()
    } else {
        regex_syntax::escape(query)
    };

    RegexMatcherBuilder::new()
        .case_insensitive(!case_sensitive)
        .word(whole_word)
        .build(&pattern)
        .map_err(|e| AppError::Search(format!("`{query}` is not a usable search pattern: {e}")))
}

/// Directories that are generated output or dependency caches, never something a person searches
/// by hand. `.gitignore` already excludes these in a normal repo; naming them here as well covers
/// a project that has no `.gitignore` (or no `.git`) and costs nothing where it does. Matched on
/// the directory's own name, at any depth.
const SKIPPED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "dist-ssr",
    "__pycache__",
    ".venv",
    ".next",
    ".nuxt",
    ".gradle",
    ".cache",
];

/// Extensions of files that are never text. They are still matched by *name*, but never opened:
/// on Windows every first open goes through the antivirus scanner, and opening a texture only for
/// binary detection to reject it is the single most wasteful thing the walk could do.
const BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "psd", "tga", "dds", "exr", "hdr", "mp3",
    "wav", "ogg", "flac", "mp4", "mov", "avi", "mkv", "webm", "zip", "gz", "tgz", "7z", "rar",
    "tar", "exe", "dll", "pdb", "so", "dylib", "lib", "a", "o", "obj", "rlib", "ttf", "otf",
    "woff", "woff2", "pck", "glb", "fbx", "blend", "wasm", "bin", "pdf", "class", "jar",
];

/// Whether the walk should not descend into a directory called `name`.
fn is_skipped_dir(name: &OsStr) -> bool {
    SKIPPED_DIRS.iter().any(|d| name == OsStr::new(d))
}

/// Whether `path` has an extension that marks it as a non-text file.
fn is_binary_extension(path: &Path) -> bool {
    path.extension().and_then(OsStr::to_str).is_some_and(|ext| {
        BINARY_EXTENSIONS
            .iter()
            .any(|b| ext.eq_ignore_ascii_case(b))
    })
}

/// How many walker threads. The work is dominated by opening files (an antivirus scan per first
/// open on Windows), which is latency, not CPU, so more threads than cores still help.
fn walk_threads() -> usize {
    let cpus = std::thread::available_parallelism().map_or(4, |n| n.get());
    (cpus * 2).clamp(4, 16)
}

/// The walk itself, once there is a directory and a compiled matcher.
///
/// Runs on `ignore`'s parallel walker: a serial walk measured ~10 ms per file on this repo because
/// each first open waits on the antivirus scanner, and that wait overlaps across threads. Never
/// returns an error: an unreadable entry, an unreadable file, or a generation that has moved on
/// are all ordinary outcomes here.
///
/// Threads race, so hits arrive in no particular order and each file only knows the match total as
/// of when it started. The result is therefore sorted by path and trimmed back to the caps at the
/// end, which keeps both the order and the limits exactly what a serial walk would have promised.
fn walk(
    root: &Path,
    matcher: &grep_regex::RegexMatcher,
    is_current: &(dyn Fn() -> bool + Sync),
    caps: &Caps,
) -> SearchResponse {
    let started = Instant::now();
    let hits: Mutex<Vec<SearchFileHit>> = Mutex::new(Vec::new());
    let total_matches = AtomicUsize::new(0);
    let file_count = AtomicUsize::new(0);
    let truncated = AtomicBool::new(false);

    let walker = WalkBuilder::new(root)
        // Dotfiles are ordinary search targets here — `.env`, `.github/`, OpenKaava's own `.kaava/` —
        // unlike ripgrep's default, which is tuned for a terminal user who types `--hidden` when
        // they want them. A GUI search box has no equivalent flag, so this always includes them.
        .hidden(false)
        // Honour `.gitignore` even where there is no `.git` directory yet (a fresh folder, an
        // exported archive) — the default only reads it inside a repository.
        .require_git(false)
        .threads(walk_threads())
        // Pruned, not merely skipped as an entry: `ignore` still descends into a directory the
        // visitor below returns `Continue` for. A directory holding its own `.git` is another
        // checkout, not part of this project's tree — in practice a linked worktree under
        // `.worktrees/`, which otherwise duplicates the whole project once per agent.
        .filter_entry(|entry| {
            if entry.file_name() == OsStr::new(".git") {
                return false;
            }
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            if is_dir && entry.depth() > 0 {
                return !is_skipped_dir(entry.file_name()) && !entry.path().join(".git").exists();
            }
            true
        })
        .build_parallel();

    let (hits_ref, total_ref, files_ref, truncated_ref) =
        (&hits, &total_matches, &file_count, &truncated);
    walker.run(|| {
        let (hits, total_matches, file_count, truncated) =
            (hits_ref, total_ref, files_ref, truncated_ref);
        let mut searcher = SearcherBuilder::new()
            // Ripgrep's own default: the first NUL byte in a file's opening bytes is proof the file
            // is not text, and it is skipped rather than scanned line by line.
            .binary_detection(BinaryDetection::quit(0))
            .line_number(true)
            .build();

        Box::new(move |entry| {
            // Once per entry — cheap next to the filesystem work around it — so a superseded
            // search stops within one entry per thread of the newer one starting.
            if !is_current() {
                truncated.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }

            // The wall-clock backstop. The caps bound the *answer*, not the time to reach it, and
            // the command answers once rather than streaming. Past the budget the walk returns
            // what it has, marked truncated, and the UI says so.
            if started.elapsed() >= caps.time_budget {
                truncated.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }

            // A permission error or a path that vanished mid-walk is not reason to lose every hit
            // found so far.
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }

            let path = entry.path();
            let name = entry.file_name().to_string_lossy();
            let name_matches = matcher.find(name.as_bytes()).ok().flatten().is_some();

            let too_large = entry
                .metadata()
                .map(|m| m.len() > caps.max_content_bytes)
                .unwrap_or(false);

            let mut matches = Vec::new();
            if !too_large && !is_binary_extension(path) {
                // Each file counts against the running total as of now; the final trim below
                // corrects for files that were scanned at the same moment.
                let before = total_matches.load(Ordering::Relaxed);
                let mut local_total = before;
                if search_file(
                    &mut searcher,
                    matcher,
                    path,
                    &mut matches,
                    &mut local_total,
                    caps.max_matches,
                ) {
                    truncated.store(true, Ordering::Relaxed);
                }
                total_matches.fetch_add(local_total - before, Ordering::Relaxed);
            }

            if name_matches || !matches.is_empty() {
                hits.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(SearchFileHit {
                        path: path.display().to_string(),
                        matches,
                    });
                file_count.fetch_add(1, Ordering::Relaxed);
            }

            if total_matches.load(Ordering::Relaxed) >= caps.max_matches
                || file_count.load(Ordering::Relaxed) >= caps.max_files
            {
                truncated.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            WalkState::Continue
        })
    });

    let mut hits = hits.into_inner().unwrap_or_else(|e| e.into_inner());
    hits.sort_by(|a, b| a.path.cmp(&b.path));
    let mut truncated = truncated.load(Ordering::Relaxed);

    // Threads overshoot the caps by whatever was in flight; trim to exactly the promised size.
    if hits.len() > caps.max_files {
        hits.truncate(caps.max_files);
        truncated = true;
    }
    let mut budget = caps.max_matches;
    for hit in hits.iter_mut() {
        if hit.matches.len() > budget {
            hit.matches.truncate(budget);
            truncated = true;
        }
        budget -= hit.matches.len();
    }

    SearchResponse { hits, truncated }
}

/// Scan one file's contents, appending every match into `matches` and counting it against the
/// shared `total_matches` budget. Returns whether the budget ran out during this file.
///
/// A file that fails to open or turns out not to be valid enough to search — permission denied,
/// deleted between the walk listing it and this reading it, or ruled out mid-read by binary
/// detection — is silently left with whatever matches (possibly none) had already been found in it,
/// the same "skip, do not sink the walk" rule the entry-level errors above follow.
fn search_file(
    searcher: &mut grep_searcher::Searcher,
    matcher: &grep_regex::RegexMatcher,
    path: &Path,
    matches: &mut Vec<SearchMatch>,
    total_matches: &mut usize,
    max_matches: usize,
) -> bool {
    let mut hit_cap = false;

    // `sinks::Bytes` rather than `sinks::UTF8`: the latter errors out of the whole file the moment
    // one line is not valid UTF-8, the all-or-nothing failure `git.rs`'s `run_git` rejects for the
    // same reason (see its doc comment on `String::from_utf8_lossy`). Decoding lossily here means a
    // source file with one stray non-UTF-8 byte still yields every match on every other line, with
    // a replacement character standing in on the one line that has a problem.
    let result = searcher.search_path(
        matcher,
        path,
        sinks::Bytes(|line_number, line_bytes| {
            // The searcher includes the line's terminator in what it hands back; trimmed here so
            // `SearchMatch.text` is the line a person would say they are looking at, not that
            // line plus an invisible newline.
            let text = String::from_utf8_lossy(line_bytes)
                .trim_end_matches(['\n', '\r'])
                .to_string();

            // The searcher finds which *lines* contain a match but does not report where within
            // them — the same reason ripgrep's own printer crate re-runs the matcher per matched
            // line to recover exact spans, not a limitation specific to this code.
            let find_result = matcher.find_iter(text.as_bytes(), |m| {
                matches.push(SearchMatch {
                    line: line_number as u32,
                    column: utf16_column(&text, m.start()),
                    text: text.clone(),
                    length: utf16_len(&text[m.start()..m.end()]),
                });
                *total_matches += 1;
                *total_matches < max_matches
            });

            if find_result.is_err() || *total_matches >= max_matches {
                hit_cap = *total_matches >= max_matches;
                // `Ok(false)` tells the searcher to stop reading this file — no budget is left, so
                // there is nothing to gain from reading the rest.
                return Ok(false);
            }

            Ok(true)
        }),
    );
    let _ = result;

    hit_cap
}

/// A UTF-8 byte offset into `line`, converted to the 1-based UTF-16 column `SearchMatch.column` is
/// documented in.
///
/// This is the one place this module has to think about the gap between how Rust and JavaScript
/// count through a string. `grep_matcher::Match` reports byte offsets — Rust's own indexing unit —
/// but the frontend hands `SearchMatch.column` straight to Monaco's `revealMatch`
/// (`previewMonaco.ts`), which measures in UTF-16 *code units*, the unit every JavaScript string
/// uses. The two agree for plain ASCII and silently disagree the moment a line has an emoji, an
/// accented letter outside Latin-1, or any other character whose UTF-8 encoding is not one byte —
/// so this walks the bytes before the match and counts them the way a JavaScript string would.
fn utf16_column(line: &str, byte_offset: usize) -> u32 {
    // `str::get` rather than slicing with `[..byte_offset]`: a `Match` from this module's own
    // `find_iter` call always lands on a char boundary (grep-matcher guarantees it), so this can
    // never actually fail — `get` is used anyway because an indexing panic here would take down the
    // whole search over one line of one file, and `unwrap_or(1)` is far cheaper insurance than
    // proving the guarantee holds under every future change to this function.
    line.get(..byte_offset)
        .map(|s| s.encode_utf16().count() as u32 + 1)
        .unwrap_or(1)
}

/// The UTF-16 length of a str slice — `SearchMatch.length`'s counterpart to `utf16_column`.
fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(time_budget: Duration) -> Caps {
        Caps {
            max_matches: 1000,
            max_files: 500,
            max_content_bytes: 8 * 1024 * 1024,
            time_budget,
        }
    }

    fn run(root: &Path, query: &str, time_budget: Duration) -> SearchResponse {
        let matcher = build_matcher(query, false, false, false).unwrap();
        walk(root, &matcher, &|| true, &caps(time_budget))
    }

    #[test]
    fn a_walk_finds_matches_in_file_contents() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.txt"),
            "one
the stack here
",
        )
        .unwrap();

        let response = run(dir.path(), "stack", Duration::from_secs(30));
        assert_eq!(response.hits.len(), 1);
        assert_eq!(response.hits[0].matches[0].line, 2);
        assert!(!response.truncated);
    }

    /// The hang's shape: a walk with no time left stops and says so instead of running on.
    #[test]
    fn an_exhausted_time_budget_returns_truncated_rather_than_walking_on() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..20 {
            std::fs::write(
                dir.path().join(format!("f{i}.txt")),
                "stack
",
            )
            .unwrap();
        }

        let response = run(dir.path(), "stack", Duration::ZERO);
        assert!(response.truncated);
        assert!(response.hits.is_empty());
    }

    #[test]
    fn a_superseded_walk_stops_and_reports_truncated() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.txt"),
            "stack
",
        )
        .unwrap();
        let matcher = build_matcher("stack", false, false, false).unwrap();

        let response = walk(
            dir.path(),
            &matcher,
            &|| false,
            &caps(Duration::from_secs(30)),
        );
        assert!(response.truncated);
    }

    #[test]
    fn the_walk_does_not_descend_into_dot_git_or_a_nested_checkout() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("keep.txt"),
            "stack
",
        )
        .unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(
            dir.path().join(".git").join("config"),
            "stack
",
        )
        .unwrap();
        // A linked worktree: `.git` is a *file* there, not a directory.
        let nested = dir.path().join(".worktrees").join("agent");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(
            nested.join(".git"),
            "gitdir: elsewhere
",
        )
        .unwrap();
        std::fs::write(
            nested.join("copy.txt"),
            "stack
",
        )
        .unwrap();

        let response = run(dir.path(), "stack", Duration::from_secs(30));
        let paths: Vec<&str> = response.hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths.len(), 1, "{paths:?}");
        assert!(paths[0].ends_with("keep.txt"));
    }

    #[test]
    fn generated_directories_are_skipped_even_without_a_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("keep.txt"),
            "stack
",
        )
        .unwrap();
        for skipped in ["node_modules", "target", "dist", "sub/node_modules"] {
            let d = dir.path().join(skipped);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(
                d.join("junk.txt"),
                "stack
",
            )
            .unwrap();
        }

        let response = run(dir.path(), "stack", Duration::from_secs(30));
        let paths: Vec<&str> = response.hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths.len(), 1, "{paths:?}");
        assert!(paths[0].ends_with("keep.txt"));
    }

    #[test]
    fn a_gitignore_is_honoured_even_without_a_git_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".gitignore"),
            "secret/
*.gen.txt
",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("keep.txt"),
            "stack
",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("a.gen.txt"),
            "stack
",
        )
        .unwrap();
        std::fs::create_dir(dir.path().join("secret")).unwrap();
        std::fs::write(
            dir.path().join("secret").join("x.txt"),
            "stack
",
        )
        .unwrap();

        let response = run(dir.path(), "stack", Duration::from_secs(30));
        let paths: Vec<&str> = response.hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths.len(), 1, "{paths:?}");
        assert!(paths[0].ends_with("keep.txt"));
    }

    #[test]
    fn a_binary_extension_is_matched_by_name_but_never_opened_for_content() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("stack.png"),
            "stack in the body
",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("other.png"),
            "stack in the body
",
        )
        .unwrap();

        let response = run(dir.path(), "stack", Duration::from_secs(30));
        assert_eq!(response.hits.len(), 1);
        assert!(response.hits[0].path.ends_with("stack.png"));
        assert!(response.hits[0].matches.is_empty());
    }

    #[test]
    fn the_file_cap_trims_a_parallel_walk_to_exactly_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..50 {
            std::fs::write(
                dir.path().join(format!("f{i:02}.txt")),
                "stack
",
            )
            .unwrap();
        }
        let matcher = build_matcher("stack", false, false, false).unwrap();
        let mut c = caps(Duration::from_secs(30));
        c.max_files = 5;

        let response = walk(dir.path(), &matcher, &|| true, &c);
        assert_eq!(response.hits.len(), 5);
        assert!(response.truncated);
    }

    #[test]
    fn skip_rules_match_by_name_and_extension() {
        assert!(is_skipped_dir(OsStr::new("node_modules")));
        assert!(!is_skipped_dir(OsStr::new("src")));
        assert!(is_binary_extension(Path::new("a/b/TEXTURE.PNG")));
        assert!(!is_binary_extension(Path::new("a/b/main.rs")));
        assert!(!is_binary_extension(Path::new("Makefile")));
    }

    /// Manual profiling, not a check: `OPENKAAVA_BENCH_ROOT=<dir> cargo test bench_walk -- --ignored
    /// --nocapture` prints how long a real tree takes for a query that matches little.
    #[test]
    #[ignore]
    fn bench_walk() {
        let root = std::env::var("OPENKAAVA_BENCH_ROOT").expect("set OPENKAAVA_BENCH_ROOT");
        for query in ["zzqxnomatch", "stack", "a"] {
            let started = Instant::now();
            let response = run(Path::new(&root), query, Duration::from_secs(600));
            eprintln!(
                "bench {query:?}: {:?}, {} hits, truncated={}",
                started.elapsed(),
                response.hits.len(),
                response.truncated
            );
        }
    }

    #[test]
    fn mb_to_bytes_converts_megabytes_to_bytes() {
        assert_eq!(mb_to_bytes(8), 8 * 1024 * 1024);
        assert_eq!(mb_to_bytes(1), 1024 * 1024);
    }

    /// The clamp a hand-edited settings file can otherwise defeat: `0` and negative values are not
    /// reachable through `Control::Number`'s own `min`, but `mb_to_bytes` still has to make sense
    /// of whatever it is handed.
    #[test]
    fn mb_to_bytes_clamps_a_non_positive_value_up_to_one_megabyte() {
        assert_eq!(mb_to_bytes(0), 1024 * 1024);
        assert_eq!(mb_to_bytes(-5), 1024 * 1024);
    }
}
