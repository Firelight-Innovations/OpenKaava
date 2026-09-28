//! Issues and pull requests for the repository a cluster's project is a
//! checkout of.
//!
//! Read-only, and that is a scope decision rather than a stage: nothing here
//! comments, merges, or opens anything on GitHub. The one thing this feature
//! *does* is hand an item to the worktree code already in `git.rs`, which is
//! why there is no worktree creation in this file at all — see
//! [`GithubItem::suggested_branch`].
//!
//! Everything is one-shot request→reply, the same model `git.rs` uses and for
//! the same reason: there is nothing to watch. The region re-asks when the
//! cluster changes and when a person presses refresh.
//!
//! The UI vocabulary — one list holding both issues and pull requests, keyed on
//! a `kind` tag, filtered by `is:` qualifiers — is adapted from `stablyai/orca`,
//! `src/shared/github/work-item-types.ts` and `src/shared/task-query.ts`. Orca
//! is MIT-licensed, © Stably AI. Its own client is Node calling the `gh` CLI;
//! none of that transfers, so what follows is a Rust rewrite against the REST
//! API rather than a translation.

use crate::error::Result;
use crate::plugins::remote::Repo;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::AppHandle;

/// Sent with every call. GitHub rejects a request without one.
const USER_AGENT: &str = concat!("OpenKaava/", env!("CARGO_PKG_VERSION"));

/// How long one request may take. Shorter than the installer's minute, because
/// this runs on a cluster switch rather than on a button somebody pressed
/// expecting a download: a list that has not arrived in twenty seconds should
/// say so and let the person carry on.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// The most of each kind that will be asked for, whatever the setting says.
///
/// GitHub's own per-page ceiling. Above it the API silently returns 100 anyway,
/// so a higher number would be a setting that appears to work and does not —
/// and paging past the first page is deliberately absent (see `fetch_items`).
const MAX_PER_PAGE: i64 = 100;

/// Which of the two things an item is.
///
/// Serialized lowercase so it lands in TypeScript as `"issue" | "pull"` rather
/// than as capitalized Rust variant names, matching `GitChangeKind` next door.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GithubItemKind {
    Issue,
    Pull,
}

/// Where an item is in its life.
///
/// Four states over two kinds: an issue is only ever `Open` or `Closed`, and
/// `Merged` and `Draft` belong to pull requests. One enum rather than two
/// because one list draws both, and the alternative — a per-kind state union —
/// would make every renderer narrow on `kind` before it could read `state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GithubItemState {
    Open,
    Closed,
    Merged,
    Draft,
}

/// One issue or pull request, with everything the list draws and nothing else.
///
/// Note what is absent. No body, no comments, no checks, no review state, no
/// diff: this is a list, and every one of those is a second request per row.
/// Orca's equivalent type carries all of them because Orca reviews pull
/// requests in-app; OpenKaava 0.2.0 browses them and opens a worktree, so the
/// fields stop where that stops.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubItem {
    /// `issue-42`, `pull-17`. Stable within one repository and unique across
    /// the two kinds, which share a number space on GitHub — issue 42 and pull
    /// request 42 cannot both exist, but nothing in the API says so, and a
    /// React key that collided would silently draw one row twice.
    pub id: String,
    pub kind: GithubItemKind,
    pub number: u64,
    pub title: String,
    pub state: GithubItemState,
    /// The `html_url`, for opening in a browser. Not the API URL.
    pub url: String,
    pub labels: Vec<String>,
    /// ISO-8601, straight from the API and not parsed. The list sorts on it as
    /// a string, which is correct for this format and avoids a date type
    /// crossing the IPC boundary — `STANDARDS.md` §2 forbids one.
    pub updated_at: String,
    /// The login. `None` for an item whose author has deleted their account,
    /// which the API reports as a null user rather than by omitting the item.
    pub author: Option<String>,
    /// A pull request's head branch. `None` for an issue, which has none.
    ///
    /// Reported so the list can show it, **not** used to check anything out —
    /// see [`Self::suggested_branch`] for why opening a pull request does not
    /// land you on this branch.
    pub head_branch: Option<String>,
    /// What to name the worktree and branch when this item is opened.
    ///
    /// Computed here rather than in the frontend so that the whole of "open
    /// this item" is `worktreeControl.create(clusterId, item.suggestedBranch)`
    /// — the existing path in `git.rs`, called with a different string. There
    /// is no second worktree-creation path in this feature, and this field is
    /// what makes that true.
    ///
    /// **For a pull request this is a fresh branch cut from HEAD, not the pull
    /// request's own head.** Checking out somebody's head branch needs a `git
    /// fetch` first, and `git.rs` says in its own header that network
    /// operations belong to the pty machinery rather than to it. Opening a
    /// pull request therefore gives you a place to work on it, not a checkout
    /// of it; the honest version of that is a `fetch` this release does not
    /// have.
    pub suggested_branch: String,
}

/// Why the list could not be fetched, in the terms the region draws.
///
/// Four cases rather than one string because they need four different
/// affordances: sign in, wait, retry, and nothing-you-can-do. A single
/// "couldn't reach GitHub" would put a Sign in button under a rate limit.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GithubTrouble {
    /// No token, or one GitHub would not accept. The region offers sign-in.
    Auth,
    /// **404, and deliberately one variant for two causes** — a repository that
    /// does not exist and one this token cannot see are indistinguishable from
    /// here. GitHub answers 404 for both precisely so a private repository's
    /// existence is not leaked, and OpenKaava must not resolve that ambiguity
    /// either. `remote.rs` makes the same call for the same reason.
    MissingOrPrivate,
    /// The hourly quota is spent. Anonymous callers get 60 an hour and a token
    /// gets 5000, so this is overwhelmingly a signed-out state, and the region
    /// says so.
    #[serde(rename_all = "camelCase")]
    RateLimited {
        /// Whole minutes until the quota resets, when GitHub said. `None`
        /// rather than a guess when the header was absent or unreadable.
        resets_in_minutes: Option<u64>,
    },
    /// Could not reach GitHub at all, or it answered something unexpected.
    /// One variant for both: from the region's side each means "try again".
    #[serde(rename_all = "camelCase")]
    Unreachable {
        /// A sentence to show. Assembled from the transport error or the
        /// status code, and **never** from a response body — a body can quote
        /// the request, and the request carries the token.
        reason: String,
    },
}

/// What the region gets back. Never an error: every outcome is a state it draws.
///
/// This is the shape that answers "never a silently empty list". `Ready` with
/// no items means the repository genuinely has no open issues or pull requests;
/// every other reason for an empty list is one of the other two variants and
/// carries its own explanation. Orca's `ListWorkItemsResult` splits `items`
/// from `errors` for the same reason, and this is the same decision made as a
/// tagged union because the shell has no partial case to represent — one
/// repository, one request pair, one answer.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum GithubFeed {
    /// The cluster has no project, its project is not a repository, or it is
    /// one whose remote is not GitHub. All three are ordinary and none is a
    /// failure — the region draws a sentence and no retry button.
    NotGithub,
    #[serde(rename_all = "camelCase")]
    Unavailable {
        /// `owner/name` when the remote was readable, which it is for
        /// everything but a repository with no remote at all.
        repo: Option<String>,
        trouble: GithubTrouble,
    },
    #[serde(rename_all = "camelCase")]
    Ready {
        repo: String,
        /// Newest first, issues and pull requests interleaved by `updatedAt`.
        items: Vec<GithubItem>,
        /// Whether a token was used. The region shows a quiet sign-in hint when
        /// this is false, because an anonymous list is real but is capped at 60
        /// requests an hour and cannot see a private repository at all.
        authenticated: bool,
    },
}

// --- naming a worktree after an item ------------------------------------------

/// Longest slug taken from a title.
///
/// `validate_worktree_name` caps the whole name at 100 characters; forty leaves
/// room for the prefix and a five-digit number while still being enough of the
/// title to recognise. A truncated slug is cut at a word boundary when there is
/// one, because `issue-42-fix-the-crash-when-the-window-i` reads worse than
/// stopping a word earlier.
const MAX_SLUG: usize = 40;

/// A title reduced to the characters a branch and a folder can both hold.
///
/// Everything outside `[a-z0-9]` becomes a dash, runs of dashes collapse, and
/// the ends are trimmed. Dots are deliberately *not* preserved even though
/// `validate_worktree_name` allows them: they are what make `..`, a trailing
/// `.` and a `.lock` suffix possible, and none of those is worth the fidelity
/// of keeping the dot in "v1.2 crashes".
///
/// Non-ASCII goes to nothing rather than being transliterated. A title written
/// entirely in another script slugs to the empty string, which
/// [`suggested_branch`] answers with a bare `issue-42` — a name that is short
/// and correct rather than one that is mojibake.
fn slugify(title: &str) -> String {
    let mut out = String::with_capacity(title.len().min(MAX_SLUG));
    let mut pending_dash = false;

    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.extend(ch.to_lowercase());
            if out.len() >= MAX_SLUG {
                break;
            }
        } else {
            pending_dash = true;
        }
    }

    if out.len() < MAX_SLUG {
        return out;
    }

    // Cut back to the last whole word, but only if that leaves most of the
    // slug. A title whose first word is longer than the cap would otherwise
    // truncate to nothing at all.
    match out.rfind('-') {
        Some(cut) if cut >= MAX_SLUG / 2 => out[..cut].to_string(),
        _ => out,
    }
}

/// The branch and folder name for opening an item.
///
/// `issue-42-the-title` and `pull-17-the-title`. The number is what makes it
/// unique and comes before the title for that reason — two issues can share a
/// title, and a person scanning `.worktrees/` reads the number first anyway.
///
/// The result always starts with a letter and contains no dots, which is what
/// makes it unconditionally acceptable to `validate_worktree_name`: a leading
/// dot or dash is impossible, `..` is impossible, and the Windows reserved
/// names are all matched on the segment before the first dot, which here is the
/// whole name and always begins `issue-` or `pull-`. The test below asserts
/// that against the real validator rather than restating the argument.
fn suggested_branch(kind: GithubItemKind, number: u64, title: &str) -> String {
    let prefix = match kind {
        GithubItemKind::Issue => "issue",
        GithubItemKind::Pull => "pull",
    };
    let slug = slugify(title);
    if slug.is_empty() {
        format!("{prefix}-{number}")
    } else {
        format!("{prefix}-{number}-{slug}")
    }
}

// --- what GitHub sends ---------------------------------------------------------

/// The subset of an issue or pull request this reads.
///
/// One struct for both endpoints. They agree on every field here, and the four
/// that only a pull request has are `Option`, which is what `serde(default)`
/// makes them for an issue. `#[serde(default)]` throughout rather than strict
/// fields: this is somebody else's API, and a list that refuses to parse
/// because one row had a null where a string was expected is a worse failure
/// than a row with an empty title.
#[derive(Debug, Deserialize)]
struct ApiItem {
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    labels: Vec<ApiLabel>,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    user: Option<ApiUser>,
    #[serde(default)]
    draft: Option<bool>,
    #[serde(default)]
    merged_at: Option<String>,
    #[serde(default)]
    head: Option<ApiRef>,
    /// Present only on an entry the *issues* endpoint returned for a pull
    /// request. That endpoint answers with both kinds — a documented quirk, not
    /// a mistake — and this field is the only thing distinguishing them, so it
    /// is what `fetch_items` filters on rather than trusting the URL shape.
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct ApiLabel {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize)]
struct ApiUser {
    #[serde(default)]
    login: String,
}

#[derive(Debug, Deserialize)]
struct ApiRef {
    #[serde(default)]
    #[serde(rename = "ref")]
    ref_name: String,
}

impl ApiItem {
    /// Turn one API row into the shape the list draws.
    ///
    /// `kind` is passed rather than inferred: the caller knows which endpoint
    /// answered, and inferring it here from `pull_request` or `head` would give
    /// the wrong answer for a pull request fetched from the pulls endpoint,
    /// where neither field says what it is.
    fn into_item(self, kind: GithubItemKind) -> GithubItem {
        let state = match kind {
            GithubItemKind::Issue => {
                if self.state == "closed" {
                    GithubItemState::Closed
                } else {
                    GithubItemState::Open
                }
            }
            GithubItemKind::Pull => {
                // Order matters. A merged pull request is `state: "closed"`
                // with `merged_at` set, and a draft is `state: "open"` with
                // `draft: true`, so merged has to be tested before closed or
                // every merged one would draw as plainly closed.
                if self.merged_at.is_some() {
                    GithubItemState::Merged
                } else if self.state == "closed" {
                    GithubItemState::Closed
                } else if self.draft == Some(true) {
                    GithubItemState::Draft
                } else {
                    GithubItemState::Open
                }
            }
        };

        let prefix = match kind {
            GithubItemKind::Issue => "issue",
            GithubItemKind::Pull => "pull",
        };

        GithubItem {
            id: format!("{prefix}-{}", self.number),
            kind,
            number: self.number,
            suggested_branch: suggested_branch(kind, self.number, &self.title),
            title: self.title,
            state,
            url: self.html_url,
            labels: self
                .labels
                .into_iter()
                .map(|label| label.name)
                .filter(|name| !name.is_empty())
                .collect(),
            updated_at: self.updated_at,
            author: self
                .user
                .map(|user| user.login)
                .filter(|login| !login.is_empty()),
            head_branch: match kind {
                GithubItemKind::Pull => self
                    .head
                    .map(|head| head.ref_name)
                    .filter(|name| !name.is_empty()),
                GithubItemKind::Issue => None,
            },
        }
    }
}

// --- talking to GitHub ---------------------------------------------------------

/// Which items to ask GitHub for.
///
/// This exists because the panel's `is:closed` filter has to reach the *fetch*
/// rather than only the list. GitHub's list endpoints take `state`, and a
/// closed item is simply not in an `open` reply — so a filter applied client
/// side over an open-only feed could only ever produce an empty list, which is
/// the exact failure the whole `GithubFeed` shape exists to prevent.
///
/// Three rather than four: `merged` is not a state GitHub's endpoint accepts.
/// A merged pull request comes back under `Closed`, and telling the two apart
/// is `merged_at`'s job in [`ApiItem::into_item`]. The panel narrows to merged
/// itself, over a closed fetch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GithubScope {
    /// What the panel opens on, and the only one that stays cheap on a busy
    /// repository — a year of closed issues sorted by activity is mostly noise.
    #[default]
    Open,
    Closed,
    All,
}

impl GithubScope {
    /// The `state=` value. GitHub spells all three exactly as we do.
    fn as_param(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
            Self::All => "all",
        }
    }
}

/// The HTTP client.
///
/// `http_status_as_error(false)` is the one way this differs from the identical
/// builder in `plugins/remote.rs`, and it is why the two are not shared. That
/// module wants a 404 as an `Err` it can match on; this one has to read
/// `x-ratelimit-remaining` off a 403 response to tell a spent quota from a
/// rejected token, and a status turned into an error has already thrown the
/// headers away.
///
/// `native-tls` comes from the crate's features, chosen in `Cargo.toml` for the
/// machine's certificate store rather than a bundled one — the note there has
/// the reasoning, and it applies here unchanged.
fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .http_status_as_error(false)
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .provider(ureq::tls::TlsProvider::NativeTls)
                // ureq's default, `WebPki`, would replace the machine's store.
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        )
        .user_agent(USER_AGENT)
        .build()
        .into()
}

/// Minutes until the quota resets, from `x-ratelimit-reset`.
///
/// The header is a Unix timestamp. A clock skewed forward would make this
/// negative, which saturates to zero rather than wrapping — "try again now" is
/// a harmless thing to say to somebody who then has to wait another minute.
fn resets_in_minutes(header: Option<&str>) -> Option<u64> {
    let resets_at: u64 = header?.trim().parse().ok()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(resets_at.saturating_sub(now).div_ceil(60))
}

/// One page of one kind, or what went wrong.
///
/// Deliberately no paging. One page of up to a hundred, newest first, is what a
/// panel this size can show, and every further page is another request against
/// a quota that is sixty an hour for a signed-out user. A person who needs the
/// hundred-and-first item wants GitHub's own search, not this list.
fn fetch_items(
    repo: &Repo,
    kind: GithubItemKind,
    scope: GithubScope,
    token: Option<&str>,
    per_page: i64,
) -> std::result::Result<Vec<GithubItem>, GithubTrouble> {
    let path = match kind {
        GithubItemKind::Issue => "issues",
        GithubItemKind::Pull => "pulls",
    };
    let url = format!(
        "https://api.github.com/repos/{}/{}/{path}?state={}&sort=updated&direction=desc&per_page={per_page}",
        repo.owner,
        repo.name,
        scope.as_param()
    );

    let mut request = agent()
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(token) = token {
        request = request.header("Authorization", &format!("Bearer {token}"));
    }

    let mut response = request.call().map_err(|err| GithubTrouble::Unreachable {
        // The transport error, which names a host and a cause. It cannot
        // contain the token: ureq's errors describe the connection, and
        // the header never reaches one.
        reason: err.to_string(),
    })?;

    let status = response.status().as_u16();
    if status == 403 || status == 429 {
        let spent = response
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|value| value.to_str().ok())
            .map(|value| value.trim() == "0")
            .unwrap_or(false);
        return Err(if spent {
            GithubTrouble::RateLimited {
                resets_in_minutes: resets_in_minutes(
                    response
                        .headers()
                        .get("x-ratelimit-reset")
                        .and_then(|value| value.to_str().ok()),
                ),
            }
        } else {
            GithubTrouble::Auth
        });
    }
    if status == 401 {
        return Err(GithubTrouble::Auth);
    }
    if status == 404 {
        return Err(GithubTrouble::MissingOrPrivate);
    }
    if !(200..300).contains(&status) {
        return Err(GithubTrouble::Unreachable {
            reason: format!("GitHub answered {status}"),
        });
    }

    let rows: Vec<ApiItem> =
        response
            .body_mut()
            .read_json()
            .map_err(|err| GithubTrouble::Unreachable {
                reason: err.to_string(),
            })?;

    Ok(rows
        .into_iter()
        // The issues endpoint answers with pull requests too. They are fetched
        // from the pulls endpoint instead, which is the only one carrying the
        // head branch and the draft flag, so the duplicates are dropped here.
        .filter(|row| kind == GithubItemKind::Pull || row.pull_request.is_none())
        .map(|row| row.into_item(kind))
        .collect())
}

/// Both lists, merged newest-first, or the first trouble either hit.
///
/// A failure in either half fails the whole feed. Orca keeps whichever half
/// succeeded and shows a banner over it; that is the right call for Orca, whose
/// two halves can come from *different repositories* — a fork's issues and an
/// upstream's pull requests. Here they are always the same repository reached
/// the same way, so one failing means the other is about to, and a half-list
/// under a warning would be a state that never honestly occurs.
fn fetch_feed(repo: &Repo, scope: GithubScope, token: Option<&str>, per_page: i64) -> GithubFeed {
    let mut items = match fetch_items(repo, GithubItemKind::Issue, scope, token, per_page) {
        Ok(items) => items,
        Err(trouble) => {
            return GithubFeed::Unavailable {
                repo: Some(repo.slug()),
                trouble,
            }
        }
    };

    match fetch_items(repo, GithubItemKind::Pull, scope, token, per_page) {
        Ok(pulls) => items.extend(pulls),
        Err(trouble) => {
            return GithubFeed::Unavailable {
                repo: Some(repo.slug()),
                trouble,
            }
        }
    }

    // Descending, so the reverse of the natural ordering. Both halves arrive
    // sorted; merging them does not preserve that, which is why this sorts
    // again rather than interleaving.
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    GithubFeed::Ready {
        repo: repo.slug(),
        items,
        authenticated: token.is_some(),
    }
}

/// Which GitHub repository a checkout belongs to, if any.
///
/// `origin` and then `upstream`, which is the order that answers correctly for
/// a fork: `origin` is your own copy, and its issues are the ones you filed.
/// Orca makes this a per-repository preference with a selector in its UI; that
/// is a real feature and deliberately not one this release has, because it
/// needs somewhere to store the choice per project and nothing here does yet.
///
/// A non-GitHub remote is `None` rather than an error. A checkout on GitLab is
/// a perfectly good checkout, and the region says so without offering a retry.
fn repo_of(checkout: &Path) -> Option<Repo> {
    for remote in ["origin", "upstream"] {
        if let Some(url) = crate::git::remote_url(checkout, remote) {
            if !is_github(&url) {
                continue;
            }
            if let Some(repo) = Repo::parse(&url) {
                return Some(repo);
            }
        }
    }
    None
}

/// Whether a remote URL points at github.com.
///
/// Checked before parsing because [`Repo::parse`] falls through to treating a
/// bare `a/b` as `owner/name`, so a GitLab URL would parse into a plausible
/// looking repository that GitHub then 404s on. GitHub Enterprise, on its own
/// hostname, is deliberately not supported: it needs a configurable API base
/// and a per-host token, and half of it would be worse than none.
fn is_github(url: &str) -> bool {
    let lowered = url.to_ascii_lowercase();
    lowered.starts_with("https://github.com/")
        || lowered.starts_with("http://github.com/")
        || lowered.starts_with("git@github.com:")
        || lowered.starts_with("github.com/")
        || lowered.starts_with("ssh://git@github.com/")
}

// --- commands ------------------------------------------------------------------

/// Everything the GitHub region draws for one cluster.
///
/// `async` with `spawn_blocking` rather than a plain `fn`, because a
/// `#[tauri::command]` that is not async runs on the **main thread** and this
/// makes two network calls — on the thread the window paints from, a slow
/// GitHub would freeze every window in the process for the length of the
/// timeout. The same reasoning `install_plugin_repo` records next door.
///
/// Returns `Ok` for every outcome including failure, which is the whole point
/// of [`GithubFeed`]: a network error here is a state to draw, not an exception
/// to surface in a dialog. The `Result` is only for the thread hop itself
/// failing, which is a panic in the worker and nothing this feature can cause.
#[tauri::command]
pub async fn github_feed(
    app: AppHandle,
    cluster_id: String,
    scope: GithubScope,
) -> Result<GithubFeed> {
    let per_page = crate::settings::number(&app, crate::settings::keys::GITHUB_ITEM_LIMIT)
        .clamp(1, MAX_PER_PAGE);

    let checkout = crate::project::cluster_path(&app, &cluster_id);

    let feed = tauri::async_runtime::spawn_blocking(move || {
        let Some(checkout) = checkout else {
            return GithubFeed::NotGithub;
        };
        let Some(repo) = repo_of(&checkout) else {
            return GithubFeed::NotGithub;
        };
        // Read inside the worker and dropped with it. The token exists in this
        // process for the length of two requests and is never returned, logged,
        // or put in a `GithubTrouble`.
        let token = crate::plugins::install::token();
        fetch_feed(&repo, scope, token.as_deref(), per_page)
    })
    .await
    .unwrap_or(GithubFeed::Unavailable {
        repo: None,
        trouble: GithubTrouble::Unreachable {
            reason: "the request could not be started".to_string(),
        },
    });

    Ok(feed)
}

/// Open one item on github.com in the user's browser.
///
/// Here rather than through the `opener` plugin's own JS binding, and the
/// difference is the point: `opener:default` in `capabilities/default.json`
/// would let the renderer hand the operating system *any* URL, and this
/// feature only ever needs to open one shape of one host. Refusing everything
/// else in Rust is a smaller permission than the capability file could express,
/// so the capability is left exactly as it was.
///
/// The URL arrives back from the frontend having originally come from GitHub's
/// own `html_url`, and is re-checked anyway. A value that has been through the
/// renderer is a value the renderer could have changed.
#[tauri::command]
pub fn github_open_in_browser(app: AppHandle, url: String) -> Result<()> {
    if !is_item_url(&url) {
        return Err(crate::error::AppError::OpenUrl {
            url,
            reason: "only a github.com address can be opened from this panel".to_string(),
        });
    }

    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(&url, None::<&str>)
        .map_err(|source| crate::error::AppError::OpenUrl {
            url,
            reason: source.to_string(),
        })
}

/// Whether a URL is an `https://github.com/...` page and nothing else.
///
/// `https` only, and a literal host match rather than a `contains`: a
/// `https://github.com.evil.example/` would satisfy a substring test and is
/// precisely what this is here to refuse. No userinfo either — a
/// `https://user:pass@github.com/` is a shape nothing here produces and one
/// that hides the real host behind an `@`.
fn is_item_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://github.com/") else {
        return false;
    };
    !rest.is_empty() && !url.contains('@') && !rest.contains("..")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_becomes_a_lowercase_dashed_slug() {
        assert_eq!(slugify("Fix the crash"), "fix-the-crash");
        assert_eq!(slugify("Fix   the    crash"), "fix-the-crash");
        assert_eq!(slugify("  Fix the crash  "), "fix-the-crash");
    }

    #[test]
    fn punctuation_and_case_do_not_survive() {
        assert_eq!(slugify("Fix: the `crash`!"), "fix-the-crash");
        assert_eq!(slugify("v1.2 crashes"), "v1-2-crashes");
        assert_eq!(slugify("A/B testing"), "a-b-testing");
    }

    /// The three shapes `validate_worktree_name` refuses outright. None can be
    /// produced, and this is the test that keeps that true as `slugify` changes.
    #[test]
    fn a_slug_never_holds_a_dot_or_a_leading_or_trailing_dash() {
        for title in [
            "...",
            ".hidden",
            "-leading",
            "trailing-",
            "config.lock",
            "a..b",
        ] {
            let slug = slugify(title);
            assert!(!slug.contains('.'), "{title:?} produced {slug:?}");
            assert!(!slug.starts_with('-'), "{title:?} produced {slug:?}");
            assert!(!slug.ends_with('-'), "{title:?} produced {slug:?}");
        }
    }

    #[test]
    fn a_title_in_another_script_slugs_to_nothing() {
        assert_eq!(slugify("日本語のタイトル"), "");
        assert_eq!(slugify("Ünïcödé"), "n-c-d");
    }

    #[test]
    fn a_long_title_is_cut_at_a_word_boundary() {
        let slug = slugify("fix the crash when the window is closed while a terminal is running");
        assert!(slug.len() <= MAX_SLUG, "{slug:?} is {} long", slug.len());
        assert!(!slug.ends_with('-'), "{slug:?}");
        assert!(
            slug.starts_with("fix-the-crash-when-the-window-is"),
            "{slug:?}"
        );
    }

    /// A single word longer than the cap has no boundary to cut back to, so it
    /// is truncated mid-word rather than to nothing.
    #[test]
    fn one_very_long_word_is_truncated_rather_than_emptied() {
        let slug = slugify(&"a".repeat(120));
        assert_eq!(slug.len(), MAX_SLUG);
    }

    #[test]
    fn a_branch_name_carries_the_kind_and_the_number() {
        assert_eq!(
            suggested_branch(GithubItemKind::Issue, 42, "Fix the crash"),
            "issue-42-fix-the-crash"
        );
        assert_eq!(
            suggested_branch(GithubItemKind::Pull, 17, "Add the widget"),
            "pull-17-add-the-widget"
        );
    }

    #[test]
    fn an_unslugabble_title_still_names_a_branch() {
        assert_eq!(
            suggested_branch(GithubItemKind::Issue, 42, "日本語"),
            "issue-42"
        );
        assert_eq!(suggested_branch(GithubItemKind::Pull, 7, ""), "pull-7");
    }

    /// The load-bearing one. Every name this generates has to be one the
    /// existing worktree path will accept, and the only way to know that is to
    /// ask the existing worktree path.
    #[test]
    fn every_generated_name_is_one_git_rs_would_accept() {
        let titles = [
            "Fix the crash",
            "...",
            "",
            "日本語のタイトル",
            "CON",
            "NUL.txt",
            "-leading dash",
            "trailing dot.",
            "a..b",
            "config.lock",
            "Ünïcödé",
            &"a".repeat(200),
            "Fix: the `crash` in <Window> — while running",
        ];
        for title in titles {
            for kind in [GithubItemKind::Issue, GithubItemKind::Pull] {
                let name = suggested_branch(kind, 12345, title);
                assert!(
                    crate::git::validate_worktree_name(&name).is_ok(),
                    "{title:?} produced {name:?}, which git.rs refuses"
                );
            }
        }
    }

    #[test]
    fn a_merged_pull_request_is_merged_rather_than_closed() {
        let row = ApiItem {
            number: 1,
            title: "Add it".to_string(),
            state: "closed".to_string(),
            html_url: String::new(),
            labels: Vec::new(),
            updated_at: String::new(),
            user: None,
            draft: Some(false),
            merged_at: Some("2026-01-01T00:00:00Z".to_string()),
            head: None,
            pull_request: None,
        };
        assert_eq!(
            row.into_item(GithubItemKind::Pull).state,
            GithubItemState::Merged
        );
    }

    #[test]
    fn a_draft_pull_request_is_draft_rather_than_open() {
        let row = ApiItem {
            number: 1,
            title: "Add it".to_string(),
            state: "open".to_string(),
            html_url: String::new(),
            labels: Vec::new(),
            updated_at: String::new(),
            user: None,
            draft: Some(true),
            merged_at: None,
            head: None,
            pull_request: None,
        };
        assert_eq!(
            row.into_item(GithubItemKind::Pull).state,
            GithubItemState::Draft
        );
    }

    /// An issue has no draft flag and no merge date, so the two pull-request
    /// states must be unreachable for one however the API answers.
    #[test]
    fn an_issue_is_only_ever_open_or_closed() {
        for (state, expected) in [
            ("open", GithubItemState::Open),
            ("closed", GithubItemState::Closed),
        ] {
            let row = ApiItem {
                number: 1,
                title: "Report".to_string(),
                state: state.to_string(),
                html_url: String::new(),
                labels: Vec::new(),
                updated_at: String::new(),
                user: None,
                draft: Some(true),
                merged_at: Some("2026-01-01T00:00:00Z".to_string()),
                head: None,
                pull_request: None,
            };
            assert_eq!(row.into_item(GithubItemKind::Issue).state, expected);
        }
    }

    #[test]
    fn an_issue_never_reports_a_head_branch() {
        let row = ApiItem {
            number: 1,
            title: "Report".to_string(),
            state: "open".to_string(),
            html_url: String::new(),
            labels: Vec::new(),
            updated_at: String::new(),
            user: None,
            draft: None,
            merged_at: None,
            head: Some(ApiRef {
                ref_name: "feat/thing".to_string(),
            }),
            pull_request: None,
        };
        assert_eq!(row.into_item(GithubItemKind::Issue).head_branch, None);
    }

    #[test]
    fn an_empty_label_or_author_is_dropped_rather_than_drawn_blank() {
        let row = ApiItem {
            number: 1,
            title: "Report".to_string(),
            state: "open".to_string(),
            html_url: String::new(),
            labels: vec![
                ApiLabel {
                    name: String::new(),
                },
                ApiLabel {
                    name: "bug".to_string(),
                },
            ],
            updated_at: String::new(),
            user: Some(ApiUser {
                login: String::new(),
            }),
            draft: None,
            merged_at: None,
            head: None,
            pull_request: None,
        };
        let item = row.into_item(GithubItemKind::Issue);
        assert_eq!(item.labels, vec!["bug".to_string()]);
        assert_eq!(item.author, None);
    }

    #[test]
    fn the_two_kinds_do_not_collide_on_one_number() {
        let row = |number| ApiItem {
            number,
            title: "Thing".to_string(),
            state: "open".to_string(),
            html_url: String::new(),
            labels: Vec::new(),
            updated_at: String::new(),
            user: None,
            draft: None,
            merged_at: None,
            head: None,
            pull_request: None,
        };
        assert_ne!(
            row(42).into_item(GithubItemKind::Issue).id,
            row(42).into_item(GithubItemKind::Pull).id
        );
    }

    #[test]
    fn only_github_remotes_are_recognised() {
        for url in [
            "https://github.com/owner/name.git",
            "git@github.com:owner/name.git",
            "ssh://git@github.com/owner/name",
            "HTTPS://GitHub.com/owner/name",
        ] {
            assert!(is_github(url), "{url:?} should be GitHub");
        }
        for url in [
            "https://gitlab.com/owner/name.git",
            "git@bitbucket.org:owner/name.git",
            "https://github.example.com/owner/name",
            "/srv/git/bare.git",
        ] {
            assert!(!is_github(url), "{url:?} should not be GitHub");
        }
    }

    /// A hostname that merely *contains* github.com must not match, or a
    /// look-alike remote would send a token to somebody else's server.
    #[test]
    fn a_lookalike_host_is_not_github() {
        assert!(!is_github("https://github.com.evil.example/owner/name"));
        assert!(!is_github("https://notgithub.com/owner/name"));
    }

    #[test]
    fn a_reset_in_the_past_reads_as_no_wait_rather_than_a_huge_one() {
        assert_eq!(resets_in_minutes(Some("0")), Some(0));
        assert_eq!(resets_in_minutes(Some("not a number")), None);
        assert_eq!(resets_in_minutes(None), None);
    }

    #[test]
    fn a_github_item_page_can_be_opened() {
        assert!(is_item_url("https://github.com/owner/name/issues/42"));
        assert!(is_item_url("https://github.com/owner/name/pull/17"));
    }

    /// This is the check standing in for a capability scope, so its refusals
    /// are the security property rather than a tidiness one. Every entry below
    /// is a way somebody could try to reach a different host or a different
    /// scheme through a panel that only ever needs github.com over TLS.
    #[test]
    fn nothing_but_a_github_page_over_tls_can_be_opened() {
        for url in [
            // A look-alike host that a `contains("github.com")` would pass.
            "https://github.com.evil.example/owner/name",
            "https://notgithub.com/owner/name",
            // Userinfo hiding the real host behind an `@`.
            "https://github.com@evil.example/owner/name",
            "https://user:pass@github.com/owner/name",
            // Wrong scheme. `file:` and `javascript:` are the two that would
            // actually cost something if handed to the operating system.
            "http://github.com/owner/name",
            "file:///C:/Windows/System32/cmd.exe",
            "javascript:alert(1)",
            "ms-msdt:/id",
            // The bare host, which is not an item and not worth opening.
            "https://github.com/",
            "",
        ] {
            assert!(!is_item_url(url), "{url:?} must not be openable");
        }
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Not part of the suite: it needs the network, and `pnpm verify` must not.
    /// Run it by hand against the real API with
    /// `cargo test --manifest-path src-tauri/Cargo.toml live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn fetches_a_real_repository() {
        let repo = Repo::parse("https://github.com/Firelight-Innovations/helve").expect("parses");
        let feed = fetch_feed(&repo, GithubScope::Open, None, 5);
        println!(
            "{}",
            serde_json::to_string_pretty(&feed).expect("serializes")
        );
    }
}

#[cfg(test)]
mod tls {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    /// **The test that would have caught the TLS misconfiguration**, without
    /// touching the network.
    ///
    /// `ureq` does not fall back when the provider a config names is not
    /// compiled in — it *panics*, and at request time rather than at build time,
    /// so nothing earlier could notice. `Cargo.toml` asked for
    /// `native-tls-no-default`, which brings the crate in but not the
    /// `native-tls` cfg flag ureq's own guard tests by name.
    ///
    /// `plugins::remote` had the same bug first and for longer, where it
    /// surfaced as a join error out of `spawn_blocking` and a generic "could not
    /// be started" at the call site.
    ///
    /// Only that the call *returned* is asserted. Any `Err` is a pass — what is
    /// being guarded against is a panic, not a status.
    #[test]
    fn an_https_request_reaches_tls_and_reports_a_failure_rather_than_panicking() {
        // A real listener, rather than a port with nothing on it. That was the
        // first attempt and it passed against the broken build: ureq checks the
        // provider in a connector wrapping the one below it, so a TCP connect
        // that fails returns before the check is ever reached.
        let listener = TcpListener::bind("127.0.0.1:0").expect("loopback is available");
        let port = listener
            .local_addr()
            .expect("the socket has an address")
            .port();

        // Accept once and hang up. The client is mid-handshake, so it reads EOF
        // and gives up immediately instead of waiting out the global timeout.
        let server = std::thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                let _ = socket.flush();
                let _ = socket.shutdown(std::net::Shutdown::Both);
            }
        });

        let result = agent().get(&format!("https://127.0.0.1:{port}/")).call();

        assert!(
            result.is_err(),
            "a socket that hung up mid-handshake cannot have produced a response"
        );
        let _ = server.join();
    }
}
