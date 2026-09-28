//! Layout presets — a named arrangement, and which app belongs in each pane.
//!
//! A cluster's layout takes work to build: split the pane, drag Files into the
//! left half, open a terminal, drag it into the right one. Having built it once,
//! there is no way to ask for it again. A preset is that arrangement given a
//! name, so the second cluster you want it in is a click rather than the same
//! four gestures.
//!
//! Why a preset is not a [`PaneNode`] is on [`PresetNode`]; what a slot may
//! name is on [`PresetSlot`]; and how a built-in stays undeletable is on
//! [`BUILTIN_PREFIX`].

pub mod store;

use crate::apps;
use crate::error::{AppError, Result};
use crate::layout::{normalize, PaneNode, SplitDir};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// The event every window listens on, so a preset saved in one appears in the
/// menus of the others without either of them asking again.
///
/// The same shape `shell:state` has and for the same reason: presets are one
/// global list, a window is a projection of it, and two windows disagreeing
/// about what exists would be a visible bug. The payload is the whole merged
/// list rather than a delta — it is small, it changes only on a deliberate
/// save, and a window that mounted late could never have heard the deltas it
/// missed, since Tauri events have no replay.
pub const PRESETS_CHANGED_EVENT: &str = "presets:changed";

/// What every built-in id begins with, and what no preset read off disk may.
///
/// [`builtins`] is compiled in and [`merge`] puts it in front of whatever is on
/// disk. Any preset read from the file whose id starts with this is discarded —
/// which is the whole of "a user cannot corrupt or delete a built-in by editing
/// `presets.json`". There is no id a hand-written entry can take that would
/// shadow, replace, or hide one.
///
/// A colon is the point: [`mint_id`] builds a user preset's id out of a slug of
/// its name, and a slug holds only lowercase letters, digits and dashes. So a
/// user id can never *accidentally* land in this namespace, and [`merge`]
/// refuses one that lands in it deliberately.
const BUILTIN_PREFIX: &str = "builtin:";

/// How deep a preset's splits may nest.
///
/// Not a limit anyone will reach by arranging panes: six levels of halving puts
/// a pane at under 2% of the window, well past the 5% floor `layout::normalize`
/// enforces, so the layout would already have stopped being what it described.
/// It is here for the other input — a hand-edited or generated `presets.json` —
/// where the cost of a very deep tree is paid on every read and every apply.
const MAX_DEPTH: usize = 6;

/// The id of the preset `project::open` applies automatically once a project
/// finishes opening.
///
/// A constant rather than a string typed again at the call site, because the
/// two have to name exactly the same built-in and nothing else would catch it
/// if they drifted — `presets::find` fails closed on a typo, not loudly.
pub const PROJECT_OPEN_PRESET_ID: &str = "builtin:files-viewer-over-terminal";

/// One thing that goes in a pane: an app in [`crate::apps::REGISTRY`], or a
/// terminal.
///
/// Not a tool. A tool's core is a child process reached over a broker that is
/// not written, so no tool can mount in this build and the shell never offers
/// one — a slot naming one could only ever produce a surface that fails to
/// load. Slots naming an app this build does not ship are dropped when the file
/// is read, which is what makes a preset written by a newer build degrade
/// rather than break.
///
/// A terminal is [`PresetSlot::Terminal`], deliberately not "an app id, with
/// `terminal` as a magic value": `REGISTRY` holds `home` and `files` and nothing
/// else, and a terminal is a [`crate::shell_state::SurfaceKind::Terminal`]
/// session with a pty behind it, opened through `commands::open_terminal` like
/// every other terminal in the app — there is one path that spawns a shell, and
/// this is not a second one. A string that sometimes means "look this up in the
/// registry" and sometimes means "spawn a shell" is the kind of union that gets
/// forgotten at exactly one of its call sites.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PresetSlot {
    #[serde(rename_all = "camelCase")]
    App {
        /// `files`. A *type*, never an instance id — see [`PresetNode`].
        app_id: String,
    },
    Terminal,
}

/// One node of a preset's shape. [`PaneNode`] with every identity removed.
///
/// Storing the cluster's tree and writing it back is the obvious
/// implementation, and it is wrong in a way worth stating because the two types
/// look almost identical. [`PaneNode`] is made of **identities**: pane ids,
/// split ids, and — in every leaf — *instance* ids, minted per session and
/// meaningless outside the cluster they came from. A preset holding `pane-3`
/// and `files-7`, applied to a cluster whose panes are `pane-11` and `pane-12`,
/// would either collide with live ids or name surfaces that no longer exist;
/// one saved in one session and applied in the next would name nothing at all.
///
/// So this is the same *shape* without them: a direction, the weights, and in
/// each pane the **app ids** that belong there. `files` is a type, and a type is
/// the only thing about a layout that outlives the session it was arranged in.
/// Turning that back into a tree — minting the panes, filling the slots — is
/// [`plan`]'s job, at the moment of applying, against whatever is actually open.
///
/// Internally tagged like `PaneNode` and for the same reason: the frontend
/// discriminates on `kind` rather than on which keys happen to be present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PresetNode {
    #[serde(rename_all = "camelCase")]
    Split {
        dir: SplitDir,
        /// One weight per child, summing to 1 — the same fractions `PaneNode`
        /// stores, for the same reason. A preset in pixels would describe the
        /// monitor it was saved on rather than the arrangement.
        sizes: Vec<f32>,
        children: Vec<PresetNode>,
    },
    #[serde(rename_all = "camelCase")]
    Pane {
        /// In tab-strip order. Usually one; more than one is a pane holding two
        /// surfaces as tabs, which is a thing the layout allows and so is a
        /// thing a preset has to be able to describe.
        slots: Vec<PresetSlot>,
    },
}

/// A named arrangement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutPreset {
    /// Stable across renames, because it is what the menu sends back when a row
    /// is clicked. A user preset's is a slug of the name it was first saved
    /// under; a built-in's carries [`BUILTIN_PREFIX`].
    pub id: String,
    pub name: String,
    /// Drawn differently in the menu, and — more to the point — the reason
    /// `merge` exists at all.
    ///
    /// `skip_deserializing`, so this is *computed* rather than read: an entry in
    /// `presets.json` claiming `"builtin": true` arrives as `false` like every
    /// other user preset. It still serializes, because the frontend reads it.
    #[serde(default, skip_deserializing)]
    pub builtin: bool,
    pub root: PresetNode,
}

// --- the built-ins ----------------------------------------------------------

/// The presets this build ships, in menu order.
///
/// The first three are chosen to make the feature explain itself on first open
/// rather than to cover every arrangement: one row, one column, and one that
/// puts two instances of the *same* app side by side — which is the thing about
/// this shell that a person coming from a single-document editor does not expect
/// to be possible, and which no amount of menu copy would tell them. The two
/// appended after them each earn their place for a narrower reason of their
/// own — see the comments on `explorer-and-viewer` and
/// `files-viewer-over-terminal` below, and [`PROJECT_OPEN_PRESET_ID`] for what
/// makes the second of those different from every other entry here.
///
/// They name the file apps, the viewer, and terminals, and never Home — a
/// built-in built around Home would be a preset for the screen you are already
/// on. That holds even for `files-viewer-over-terminal`, which `project::open`
/// applies the moment Home hands a cluster off to a real project: it is a
/// caller's decision about *when* to reach for this arrangement, not a reason
/// for the arrangement itself to know Home exists.
pub fn builtins() -> Vec<LayoutPreset> {
    vec![
        LayoutPreset {
            id: format!("{BUILTIN_PREFIX}files-and-terminal"),
            name: "Files & Terminal".to_string(),
            builtin: true,
            root: PresetNode::Split {
                dir: SplitDir::Row,
                // The terminal takes the narrower side: it is the thing being
                // watched rather than the thing being read.
                sizes: vec![0.65, 0.35],
                children: vec![app_pane("files"), terminal_pane()],
            },
        },
        LayoutPreset {
            id: format!("{BUILTIN_PREFIX}two-files"),
            name: "Two Files".to_string(),
            builtin: true,
            root: PresetNode::Split {
                dir: SplitDir::Row,
                sizes: vec![0.5, 0.5],
                children: vec![app_pane("files"), app_pane("files")],
            },
        },
        LayoutPreset {
            id: format!("{BUILTIN_PREFIX}files-over-terminal"),
            name: "Files over Terminal".to_string(),
            builtin: true,
            root: PresetNode::Split {
                dir: SplitDir::Column,
                sizes: vec![0.7, 0.3],
                children: vec![app_pane("files"), terminal_pane()],
            },
        },
        // The one a person coming from VS Code is looking for: the tree beside
        // the file. It is a *preset* rather than the shape of one app, which is
        // the point of the split — this layout is something the user can
        // rearrange, move to another monitor, or throw away, where the old
        // Files could only ever draw it one way in one pane.
        //
        // Appended rather than put first, though it is the one most people will
        // want. The tests below index `builtins()` positionally, and an
        // insertion at the front silently re-points every one of them at a
        // different preset — several would still pass while asserting about
        // something else, which is worse than the ones that fail.
        LayoutPreset {
            id: format!("{BUILTIN_PREFIX}explorer-and-viewer"),
            name: "Explorer & Viewer".to_string(),
            builtin: true,
            root: PresetNode::Split {
                dir: SplitDir::Row,
                // The proportions the old in-app splitter defaulted to: 260px
                // of tree against everything else, near enough, so the layout
                // people already had does not shift under them.
                sizes: vec![0.25, 0.75],
                children: vec![app_pane("files"), app_pane("viewer")],
            },
        },
        // The one nobody clicks, because `project::open` clicks it for them.
        // Opening a project used to leave Home sitting in the cluster it had
        // just handed off, with the file tree and the viewer nowhere on
        // screen until the user went and asked the Apps menu for each of
        // them by hand. This is that arrangement, applied the instant there
        // is a project to arrange it around — see `PROJECT_OPEN_PRESET_ID`
        // and `commands::apply_project_open_preset`.
        //
        // Also appended, and for the same reason `explorer-and-viewer` gives
        // above: the tests index `builtins()` positionally, and putting this
        // anywhere but last would silently re-point them at the wrong entry.
        LayoutPreset {
            id: PROJECT_OPEN_PRESET_ID.to_string(),
            name: "Files & Viewer over Terminal".to_string(),
            builtin: true,
            root: PresetNode::Split {
                dir: SplitDir::Column,
                // The terminal takes the narrower share, same as
                // `files-over-terminal`: it is what you watch while you work
                // in the row above, not the thing the eye starts on.
                sizes: vec![0.7, 0.3],
                children: vec![
                    PresetNode::Split {
                        dir: SplitDir::Row,
                        // `explorer-and-viewer`'s own proportions — this row
                        // is that preset, nested, so a project opened this
                        // way and a project arranged by hand read the same.
                        sizes: vec![0.25, 0.75],
                        children: vec![app_pane("files"), app_pane("viewer")],
                    },
                    terminal_pane(),
                ],
            },
        },
    ]
}

fn app_pane(app_id: &str) -> PresetNode {
    PresetNode::Pane {
        slots: vec![PresetSlot::App {
            app_id: app_id.to_string(),
        }],
    }
}

fn terminal_pane() -> PresetNode {
    PresetNode::Pane {
        slots: vec![PresetSlot::Terminal],
    }
}

// --- reading -----------------------------------------------------------------

/// The list every menu draws: the built-ins, then whatever survives of the file.
///
/// Four things are dropped rather than shown, each a way a hand-edited or
/// future-written `presets.json` could degrade the menu rather than itself:
///
///   * **An id in the built-in namespace.** The rule that makes a built-in
///     undeletable and uncorruptable: no entry a file can hold replaces one.
///   * **A duplicate id.** Two rows answering to one name, with `find` silently
///     picking whichever came first.
///   * **A name a built-in or an earlier user preset already holds**, compared
///     without case. Two rows reading `Two Files` that do different things is
///     worse than one row and a line in the log. [`save`] refuses such a name up
///     front, so reaching this means the file was edited by hand.
///   * **A blank id or name.** A menu row with no label.
///
/// Everything that survives is [`PresetNode::normalized`], which is where a slot
/// naming an app this build does not ship goes.
pub fn merge(user: Vec<LayoutPreset>) -> Vec<LayoutPreset> {
    let mut out = builtins();

    for mut preset in user {
        if preset.id.starts_with(BUILTIN_PREFIX) {
            crate::kaava_log!(
                "ignoring the preset `{}` — `{BUILTIN_PREFIX}` names OpenKaava's own presets",
                preset.id
            );
            continue;
        }
        if preset.id.trim().is_empty() || preset.name.trim().is_empty() {
            continue;
        }
        if out.iter().any(|p| p.id == preset.id) {
            continue;
        }
        if out
            .iter()
            .any(|p| p.name.eq_ignore_ascii_case(&preset.name))
        {
            crate::kaava_log!(
                "ignoring the preset `{}` — that name is already taken",
                preset.name
            );
            continue;
        }

        // Never trusted from the file; see the field's own comment.
        preset.builtin = false;
        preset.root = preset.root.normalized(0);
        out.push(preset);
    }

    out
}

/// Every preset, built-ins included. What `commands::list_presets` answers with.
pub fn list(app: &AppHandle) -> Vec<LayoutPreset> {
    merge(store::load(app).presets)
}

/// One preset by id, or `None` — which the caller should treat as "it was
/// removed from the file since the menu was drawn" rather than as impossible.
pub fn find(app: &AppHandle, id: &str) -> Option<LayoutPreset> {
    list(app).into_iter().find(|p| p.id == id)
}

// --- writing -----------------------------------------------------------------

/// Save the arrangement in `root` under `name`, and tell every window.
///
/// **Saving under a name a user preset already holds replaces it.** That is the
/// only way this build has of editing a preset — there is no rename and no
/// delete — and it is the behaviour of every Save As in every application, so it
/// is not a surprise anyone has to be told about.
///
/// **Saving under a built-in's name is refused.** The alternative is two rows
/// with one label, since a built-in cannot be replaced; refusing says so at the
/// moment the name is typed, where the menu can put the reason under the field,
/// rather than at the moment it silently fails to appear.
pub fn save(app: &AppHandle, name: &str, root: PresetNode) -> Result<Vec<LayoutPreset>> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::PresetName(
            "a preset needs a name to be found by".to_string(),
        ));
    }
    if let Some(clash) = builtins()
        .iter()
        .find(|b| b.name.eq_ignore_ascii_case(name))
    {
        return Err(AppError::PresetName(format!(
            "\"{}\" is one of OpenKaava's own presets, so it cannot be replaced — pick another name",
            clash.name
        )));
    }

    let mut stored = store::load(app);
    let root = root.normalized(0);

    match stored
        .presets
        .iter_mut()
        .find(|p| p.name.eq_ignore_ascii_case(name))
    {
        Some(existing) => {
            // The id is deliberately left alone. It is what the menu sends back,
            // and re-slugging it on every save would break nothing today and
            // break anything that ever remembers a preset by id.
            existing.name = name.to_string();
            existing.root = root;
        }
        None => {
            let taken: Vec<String> = stored.presets.iter().map(|p| p.id.clone()).collect();
            stored.presets.push(LayoutPreset {
                id: mint_id(name, &taken),
                name: name.to_string(),
                builtin: false,
                root,
            });
        }
    }

    store::save(app, &stored);

    let merged = merge(stored.presets);
    let _ = app.emit(PRESETS_CHANGED_EVENT, &merged);
    Ok(merged)
}

/// A stable id from a name: `Editor & Terminal` becomes `editor-terminal`.
///
/// Slugged rather than randomised so that a hand-read `presets.json` is legible
/// and so that the id says which row it belongs to. Everything outside
/// `[a-z0-9]` collapses to a single dash, which is also what keeps a user id out
/// of the built-in namespace: [`BUILTIN_PREFIX`] contains a colon, and no slug
/// can.
///
/// A name that slugs to nothing at all — one written entirely in a script this
/// rule strips — still gets an id, because the alternative is a preset that
/// saves and then cannot be found. `preset`, `preset-2` and so on is not pretty
/// and is not meant to be read; the *name* is what the menu draws.
fn mint_id(name: &str, taken: &[String]) -> String {
    let mut slug = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let base = slug.trim_matches('-').to_string();
    let base = if base.is_empty() {
        "preset".to_string()
    } else {
        base
    };

    if !taken.iter().any(|t| t == &base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|candidate| !taken.iter().any(|t| t == candidate))
        // `(2..)` over `u32` is bounded, so `find` can in principle run out.
        // Falling back to the base is a collision `merge` then drops, which is a
        // preset that did not save — annoying, and four billion better than a
        // panic in the backend.
        .unwrap_or(base)
}

// --- the shape ---------------------------------------------------------------

impl PresetNode {
    /// A preset that can be applied without surprises, whatever the file said.
    ///
    /// Four repairs, each for an input that is either a hand-edited file or a
    /// preset written by a build that shipped something this one does not:
    ///
    ///   * **A slot naming an app not in the registry is dropped** — a preset
    ///     from a newer build degrades to the panes it can still fill rather
    ///     than opening a surface that cannot load, and no tool id gets in (see
    ///     [`PresetSlot`]).
    ///   * **A pane with no slots left is dropped**: nothing for it to hold, and
    ///     an empty pane in an applied layout is a gap.
    ///   * **A split with fewer than two children collapses into its only
    ///     child** — the invariant, and the reasoning, of `layout::prune`.
    ///   * **Weights are aligned to the children and normalized**, through the
    ///     very function the live tree uses, so a preset cannot describe a
    ///     layout the layout engine would refuse to draw.
    ///
    /// `depth` is the recursion guard at [`MAX_DEPTH`]: past it a split becomes
    /// its first child rather than being followed.
    fn normalized(self, depth: usize) -> PresetNode {
        match self {
            PresetNode::Pane { slots } => PresetNode::Pane {
                slots: slots
                    .into_iter()
                    .filter(|slot| match slot {
                        // A page's app has its own cluster; see `pages`.
                        PresetSlot::App { app_id } => {
                            apps::is_app(app_id) && !crate::pages::is_page_app(app_id)
                        }
                        PresetSlot::Terminal => true,
                    })
                    .collect(),
            },
            PresetNode::Split {
                dir,
                sizes,
                children,
            } => {
                if depth >= MAX_DEPTH {
                    return children
                        .into_iter()
                        .next()
                        .map(|c| c.normalized(depth))
                        .unwrap_or(PresetNode::Pane { slots: Vec::new() });
                }

                // Rebuilt as a pair rather than filtered separately, exactly as
                // `layout::prune` does it: `sizes[i]` describes `children[i]`,
                // and an edit that updated one and not the other leaves every
                // pane after it drawing at its neighbour's width.
                let even = 1.0 / children.len().max(1) as f32;
                let mut next_children = Vec::new();
                let mut next_sizes = Vec::new();
                for (i, child) in children.into_iter().enumerate() {
                    let child = child.normalized(depth + 1);
                    if child.is_empty_pane() {
                        continue;
                    }
                    next_children.push(child);
                    next_sizes.push(sizes.get(i).copied().unwrap_or(even));
                }

                match next_children.len() {
                    0 => PresetNode::Pane { slots: Vec::new() },
                    1 => next_children.remove(0),
                    _ => {
                        normalize(&mut next_sizes);
                        PresetNode::Split {
                            dir,
                            sizes: next_sizes,
                            children: next_children,
                        }
                    }
                }
            }
        }
    }

    fn is_empty_pane(&self) -> bool {
        matches!(self, PresetNode::Pane { slots } if slots.is_empty())
    }

    /// How many panes applying this will need ids for.
    pub fn pane_count(&self) -> usize {
        match self {
            PresetNode::Pane { .. } => 1,
            PresetNode::Split { children, .. } => children.iter().map(Self::pane_count).sum(),
        }
    }

    /// How many splits applying this will need ids for.
    pub fn split_count(&self) -> usize {
        match self {
            PresetNode::Pane { .. } => 0,
            PresetNode::Split { children, .. } => {
                1 + children.iter().map(Self::split_count).sum::<usize>()
            }
        }
    }
}

// --- capturing ---------------------------------------------------------------

/// Turn a live cluster's tree into a preset's shape.
///
/// `slot_of` resolves one tab id to what it is — an app, a terminal, or nothing
/// at all for an id whose surface has gone. The caller supplies it because the
/// answer lives in `ShellState`'s flat `instances` and `terminals` lists, and
/// this module has deliberately never heard of either.
///
/// Tabs that resolve to nothing are dropped rather than guessed at, and so is
/// any pane they empty. What is being saved is "the arrangement I am looking
/// at"; a pane that is empty on screen is not part of it.
pub fn capture(tree: &PaneNode, slot_of: &impl Fn(&str) -> Option<PresetSlot>) -> PresetNode {
    build_preset(tree, slot_of).normalized(0)
}

fn build_preset(node: &PaneNode, slot_of: &impl Fn(&str) -> Option<PresetSlot>) -> PresetNode {
    match node {
        PaneNode::Leaf { tabs, .. } => PresetNode::Pane {
            slots: tabs.iter().filter_map(|id| slot_of(id)).collect(),
        },
        PaneNode::Split {
            dir,
            sizes,
            children,
            ..
        } => PresetNode::Split {
            dir: *dir,
            sizes: sizes.clone(),
            children: children.iter().map(|c| build_preset(c, slot_of)).collect(),
        },
    }
}

// --- applying ----------------------------------------------------------------

/// One surface already open in the cluster a preset is being applied to.
#[derive(Debug, Clone)]
pub struct Existing {
    pub instance_id: String,
    /// Which slot this surface could fill, or `None` for one that could fill
    /// none.
    ///
    /// The same question [`capture`]'s `slot_of` answers, asked from the other
    /// side, which is why it is the same type. `None` is not only theoretical:
    /// a tab id with no surface behind it should not happen and does not
    /// resolve, and it must not be allowed to claim a terminal slot on the
    /// grounds that it is not an app either. It stays a leftover, so it is still
    /// on screen drawing its raw id — which is how anyone finds out the state
    /// went wrong at all.
    pub fills: Option<PresetSlot>,
}

/// A slot the cluster had nothing to fill with, for the caller to open.
///
/// Returned rather than opened here, because opening is not something this
/// module can do: an app instance is minted by `ShellState` and a terminal needs
/// a pty, which lives two modules away in `PtySessions`. What is decided here is
/// *where each one goes*, which is the part worth testing.
#[derive(Debug, Clone, PartialEq)]
pub struct Gap {
    pub pane_id: String,
    /// Where in the pane's tab strip this slot belongs, or `None` when appending
    /// puts it there anyway.
    ///
    /// `None` for every pane holding a single slot, which is almost all of them
    /// — and that matters because the caller can skip a whole second state
    /// mutation per surface whenever it is `None`.
    pub index: Option<usize>,
    pub slot: PresetSlot,
}

/// Fresh pane and split ids for the tree a preset is about to become.
///
/// Minted from `Counters` *before* the state lock is taken, which is the
/// ordering `ShellState::split_with_instance` already uses: minting an id and
/// publishing the thing it names must not be two separately-observable events.
pub struct Ids {
    panes: Vec<String>,
    splits: Vec<String>,
    pane_at: usize,
    split_at: usize,
}

impl Ids {
    pub fn new(panes: Vec<String>, splits: Vec<String>) -> Self {
        Ids {
            panes,
            splits,
            pane_at: 0,
            split_at: 0,
        }
    }

    /// The fallbacks are unreachable by construction — the caller mints exactly
    /// [`PresetNode::pane_count`] and [`PresetNode::split_count`] of them. They
    /// are a fallback rather than an `expect` because a miscount would otherwise
    /// take the whole backend down over a layout, and because neither spelling
    /// can collide with a real id: `trailing_ordinal` cannot parse `x0` off the
    /// end, so nothing will ever mint one of these a second time.
    fn pane(&mut self) -> String {
        let id = self
            .panes
            .get(self.pane_at)
            .cloned()
            .unwrap_or_else(|| format!("pane-x{}", self.pane_at));
        self.pane_at += 1;
        id
    }

    fn split(&mut self) -> String {
        let id = self
            .splits
            .get(self.split_at)
            .cloned()
            .unwrap_or_else(|| format!("split-x{}", self.split_at));
        self.split_at += 1;
        id
    }
}

/// Work out the tree a preset produces in a cluster that already has things in
/// it, and what is still missing.
///
/// The important part: **nothing is ever closed.** A preset says where things
/// go; it does not say what should stop existing. Silently destroying an open
/// editor because the preset that was clicked did not mention it is the worst
/// thing this feature could do — the work is gone, the gesture that lost it was
/// a menu click, and there is no undo anywhere in this shell. So:
///
///   * A surface already in the cluster whose app matches a slot **moves into
///     that slot** — applying `Files | Terminal` to a cluster that already
///     holds a Files rearranges the Files you have rather than opening a second
///     one beside it and leaving the first somewhere else. Which surface fills
///     which slot is `claim`'s rule.
///   * A slot with nothing to fill it comes back as a [`Gap`], and the caller
///     opens a fresh surface for it.
///   * **Everything else lands in the last pane**, in the order it was already
///     in. It is still open, it is still yours, and it is somewhere obvious
///     rather than somewhere clever.
pub fn plan(root: &PresetNode, existing: &[Existing], ids: &mut Ids) -> (PaneNode, Vec<Gap>) {
    let mut claimed = vec![false; existing.len()];
    let mut gaps = Vec::new();
    let mut tree = build_tree(root, existing, &mut claimed, &mut gaps, ids);

    // The leftovers, in the order they were already in. Written straight into
    // the last leaf rather than through `insert_tab`, because that would make
    // each one the pane's active tab in turn — and the tab a pane shows should
    // be the one the preset asked for, not whichever unrelated surface happened
    // to be swept in last.
    let leftovers: Vec<String> = existing
        .iter()
        .zip(&claimed)
        .filter(|(_, taken)| !**taken)
        .map(|(e, _)| e.instance_id.clone())
        .collect();

    if !leftovers.is_empty() {
        // Found by id in two walks rather than descended to in one. Not a
        // roundabout way of saying the same thing: a single mutable descent that
        // can also hand the node back is a borrow the checker will not allow,
        // and `layout` splits `first_pane_id` from `find_leaf_mut` for exactly
        // this reason. Two walks of a tree with a handful of nodes cost nothing.
        let last = last_pane_id(&tree).to_string();
        if let Some(PaneNode::Leaf {
            tabs, active_tab, ..
        }) = leaf_mut(&mut tree, &last)
        {
            if active_tab.is_none() {
                *active_tab = Some(leftovers[0].clone());
            }
            tabs.extend(leftovers);
        }
    }

    (tree, gaps)
}

fn build_tree(
    node: &PresetNode,
    existing: &[Existing],
    claimed: &mut [bool],
    gaps: &mut Vec<Gap>,
    ids: &mut Ids,
) -> PaneNode {
    match node {
        PresetNode::Pane { slots } => {
            let pane_id = ids.pane();
            let mut tabs: Vec<String> = Vec::new();

            for (index, slot) in slots.iter().enumerate() {
                match claim(slot, existing, claimed) {
                    Some(instance_id) => tabs.push(instance_id),
                    None => gaps.push(Gap {
                        pane_id: pane_id.clone(),
                        // Only a pane holding more than one slot can have a gap
                        // that appending would put in the wrong place. Saying so
                        // here rather than at the call site is what lets the
                        // caller skip a second mutation for the common pane.
                        index: (slots.len() > 1).then_some(index),
                        slot: slot.clone(),
                    }),
                }
            }

            PaneNode::Leaf {
                id: pane_id,
                active_tab: tabs.first().cloned(),
                tabs,
            }
        }
        PresetNode::Split {
            dir,
            sizes,
            children,
        } => {
            // The split's own id first, then its children's, so the assignment
            // order is fixed and a plan is the same every time it is run.
            let split_id = ids.split();
            PaneNode::Split {
                id: split_id,
                dir: *dir,
                sizes: sizes.clone(),
                children: children
                    .iter()
                    .map(|c| build_tree(c, existing, claimed, gaps, ids))
                    .collect(),
            }
        }
    }
}

/// The first surface in layout order that fits `slot` and has not been taken.
///
/// First-unclaimed-wins, so a cluster with two Files and a preset with two Files
/// slots fills them left to right with the two you had, rather than reusing one
/// and opening another.
///
/// Equality on [`PresetSlot`] is the whole of the match, which is what makes
/// `App { app_id: "files" }` mean "any Files" and `Terminal` mean "a terminal
/// already in this cluster's tree". That second one is reuse rather than
/// laziness: the preset asked for a terminal in that pane, there is one here the
/// user is already working in, and spawning a second shell beside it while
/// sweeping the first into the last pane would be a strange thing to have asked
/// for.
fn claim(slot: &PresetSlot, existing: &[Existing], claimed: &mut [bool]) -> Option<String> {
    let position = existing
        .iter()
        .zip(claimed.iter())
        .position(|(e, taken)| !taken && e.fills.as_ref() == Some(slot))?;
    claimed[position] = true;
    Some(existing[position].instance_id.clone())
}

/// The last pane in layout order — where anything the preset did not mention
/// goes. `layout::first_pane_id`, from the other end.
fn last_pane_id(node: &PaneNode) -> &str {
    match node {
        PaneNode::Leaf { id, .. } => id,
        // `last` rather than `[len - 1]`, and the split's own id as the fallback
        // — a childless split is not a state `plan` can build, and a hand-built
        // tree should not be able to panic the backend.
        PaneNode::Split { id, children, .. } => children.last().map_or(id.as_str(), last_pane_id),
    }
}

/// The leaf with this id. A copy of `layout::find_leaf_mut`, which is private to
/// that module and deliberately staying so — the tree's own mutators are its
/// business, and this is a read of a tree `plan` has just built itself.
fn leaf_mut<'a>(node: &'a mut PaneNode, pane_id: &str) -> Option<&'a mut PaneNode> {
    match node {
        PaneNode::Leaf { id, .. } if id == pane_id => Some(node),
        PaneNode::Leaf { .. } => None,
        PaneNode::Split { children, .. } => children.iter_mut().find_map(|c| leaf_mut(c, pane_id)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids_for(root: &PresetNode) -> Ids {
        Ids::new(
            (1..=root.pane_count())
                .map(|n| format!("pane-{n}"))
                .collect(),
            (1..=root.split_count())
                .map(|n| format!("split-{n}"))
                .collect(),
        )
    }

    fn open(instance_id: &str, app_id: &str) -> Existing {
        Existing {
            instance_id: instance_id.to_string(),
            fills: Some(PresetSlot::App {
                app_id: app_id.to_string(),
            }),
        }
    }

    fn terminal(instance_id: &str) -> Existing {
        Existing {
            instance_id: instance_id.to_string(),
            fills: Some(PresetSlot::Terminal),
        }
    }

    /// A tab id with no surface behind it. Should not happen; must not be
    /// mistaken for a terminal when it does.
    fn ghost(instance_id: &str) -> Existing {
        Existing {
            instance_id: instance_id.to_string(),
            fills: None,
        }
    }

    fn tabs_of(node: &PaneNode) -> Vec<Vec<&str>> {
        match node {
            PaneNode::Leaf { tabs, .. } => vec![tabs.iter().map(String::as_str).collect()],
            PaneNode::Split { children, .. } => children.iter().flat_map(tabs_of).collect(),
        }
    }

    // --- the shape ----------------------------------------------------------

    #[test]
    fn a_slot_naming_an_app_this_build_does_not_ship_is_dropped() {
        let root = PresetNode::Pane {
            slots: vec![
                PresetSlot::App {
                    app_id: "files".to_string(),
                },
                PresetSlot::App {
                    app_id: "a-tool-from-2027".to_string(),
                },
                PresetSlot::Terminal,
            ],
        }
        .normalized(0);

        assert_eq!(
            root,
            PresetNode::Pane {
                slots: vec![
                    PresetSlot::App {
                        app_id: "files".to_string()
                    },
                    PresetSlot::Terminal,
                ],
            },
            "a preset from a newer build degrades to what this one can fill"
        );
    }

    /// A page lives in its own cluster, so a preset cannot put it in a pane —
    /// not even one saved before the app became a page.
    #[test]
    fn a_slot_naming_a_page_app_is_dropped() {
        let root = PresetNode::Split {
            dir: SplitDir::Row,
            sizes: vec![0.5, 0.5],
            children: vec![app_pane("files"), app_pane("agents")],
        }
        .normalized(0);

        assert_eq!(root, app_pane("files"));
    }

    #[test]
    fn a_split_left_with_one_child_collapses_into_it() {
        let root = PresetNode::Split {
            dir: SplitDir::Row,
            sizes: vec![0.5, 0.5],
            children: vec![app_pane("files"), app_pane("nonesuch")],
        }
        .normalized(0);

        assert_eq!(root, app_pane("files"), "not a split with one child");
    }

    #[test]
    fn weights_are_realigned_when_a_child_is_dropped() {
        let root = PresetNode::Split {
            dir: SplitDir::Row,
            sizes: vec![0.2, 0.5, 0.3],
            children: vec![app_pane("files"), app_pane("nonesuch"), terminal_pane()],
        }
        .normalized(0);

        let PresetNode::Split {
            sizes, children, ..
        } = &root
        else {
            panic!("expected a split, got {root:?}");
        };
        assert_eq!(children.len(), 2);
        assert!(
            (sizes.iter().sum::<f32>() - 1.0).abs() < 1e-5,
            "the surviving weights still sum to 1: {sizes:?}"
        );
        assert!(
            sizes[1] > sizes[0],
            "0.3 was the larger of the two survivors"
        );
    }

    #[test]
    fn nesting_past_the_depth_cap_stops_rather_than_recursing() {
        let mut root = app_pane("files");
        for _ in 0..40 {
            root = PresetNode::Split {
                dir: SplitDir::Row,
                sizes: vec![0.5, 0.5],
                children: vec![root, terminal_pane()],
            };
        }

        let normalized = root.normalized(0);
        assert!(
            normalized.pane_count() <= MAX_DEPTH + 1,
            "a hand-edited file cannot make every apply walk forty levels"
        );
    }

    // --- ids ----------------------------------------------------------------

    #[test]
    fn a_user_preset_cannot_take_a_builtin_id() {
        let slug = mint_id("builtin: Two Files", &[]);
        assert!(
            !slug.starts_with(BUILTIN_PREFIX),
            "a slug holds no colon, so it cannot land in the reserved namespace: {slug}"
        );
        assert_eq!(slug, "builtin-two-files");
    }

    #[test]
    fn an_id_that_is_taken_is_numbered_rather_than_reused() {
        assert_eq!(mint_id("Editor", &["editor".to_string()]), "editor-2");
        assert_eq!(
            mint_id("Editor", &["editor".to_string(), "editor-2".to_string()]),
            "editor-3"
        );
    }

    #[test]
    fn a_name_that_slugs_to_nothing_still_gets_an_id() {
        assert_eq!(mint_id("!!!", &[]), "preset");
    }

    // --- merging ------------------------------------------------------------

    fn user(id: &str, name: &str) -> LayoutPreset {
        LayoutPreset {
            id: id.to_string(),
            name: name.to_string(),
            builtin: false,
            root: app_pane("files"),
        }
    }

    /// The whole of "a user must not be able to delete or corrupt a built-in by
    /// editing the file": there is no entry that can stand in for one.
    #[test]
    fn a_file_entry_cannot_shadow_a_builtin() {
        let mut impostor = user(&format!("{BUILTIN_PREFIX}two-files"), "Two Files");
        impostor.root = PresetNode::Pane { slots: Vec::new() };
        impostor.builtin = true;

        let merged = merge(vec![impostor]);

        assert_eq!(merged.len(), builtins().len(), "nothing was added");
        let real = merged
            .iter()
            .find(|p| p.id == format!("{BUILTIN_PREFIX}two-files"))
            .expect("the built-in is still there");
        assert_eq!(real.root, builtins()[1].root, "and is the compiled-in one");
    }

    #[test]
    fn a_user_preset_may_not_take_a_builtins_name() {
        let merged = merge(vec![user("mine", "two files")]);
        assert_eq!(merged.len(), builtins().len(), "compared without case");
    }

    #[test]
    fn built_in_is_computed_rather_than_read_from_the_file() {
        let json = r#"{"id":"mine","name":"Mine","builtin":true,
                       "root":{"kind":"pane","slots":[]}}"#;
        let read: LayoutPreset = serde_json::from_str(json).expect("it parses");
        assert!(!read.builtin, "the file does not get to claim this");
    }

    #[test]
    fn user_presets_follow_the_builtins_and_keep_their_order() {
        let merged = merge(vec![user("a", "Alpha"), user("b", "Beta")]);
        let names: Vec<&str> = merged.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            &names[..5],
            &[
                "Files & Terminal",
                "Two Files",
                "Files over Terminal",
                "Explorer & Viewer",
                "Files & Viewer over Terminal",
            ]
        );
        assert_eq!(&names[5..], &["Alpha", "Beta"]);
    }

    /// The shape `project::open` relies on: the file tree and the viewer on
    /// top, a terminal beneath, and — because a `Cluster::apply_preset` caller
    /// resolves this preset by id rather than by position — an id that matches
    /// [`PROJECT_OPEN_PRESET_ID`] exactly.
    #[test]
    fn the_project_open_preset_is_files_and_viewer_over_a_terminal() {
        let preset = builtins()
            .into_iter()
            .find(|p| p.id == PROJECT_OPEN_PRESET_ID)
            .expect("it is one of the built-ins");

        let PresetNode::Split {
            dir: outer_dir,
            children: outer_children,
            ..
        } = &preset.root
        else {
            panic!("expected the outer split, got {:?}", preset.root);
        };
        assert_eq!(*outer_dir, SplitDir::Column, "row on top, terminal below");
        assert_eq!(outer_children[1], terminal_pane());

        let PresetNode::Split {
            dir: inner_dir,
            children: inner_children,
            ..
        } = &outer_children[0]
        else {
            panic!("expected the inner split, got {:?}", outer_children[0]);
        };
        assert_eq!(*inner_dir, SplitDir::Row);
        assert_eq!(inner_children, &[app_pane("files"), app_pane("viewer")]);
    }

    // --- applying -----------------------------------------------------------

    #[test]
    fn a_preset_applied_to_an_empty_cluster_is_all_gaps() {
        let root = builtins()[0].root.clone();
        let (tree, gaps) = plan(&root, &[], &mut ids_for(&root));

        assert_eq!(tabs_of(&tree), vec![Vec::<&str>::new(), Vec::new()]);
        assert_eq!(gaps.len(), 2);
        assert_eq!(gaps[0].pane_id, "pane-1");
        assert_eq!(
            gaps[0].slot,
            PresetSlot::App {
                app_id: "files".to_string()
            }
        );
        assert_eq!(gaps[1].slot, PresetSlot::Terminal);
        assert!(
            gaps.iter().all(|g| g.index.is_none()),
            "one slot per pane, so appending is right"
        );
    }

    /// The reuse half of the rule: a Files already open is *moved* into the
    /// slot, not duplicated beside it.
    #[test]
    fn a_surface_that_matches_a_slot_is_placed_in_it_rather_than_reopened() {
        let root = builtins()[0].root.clone();
        let existing = vec![open("files-1", "files")];
        let (tree, gaps) = plan(&root, &existing, &mut ids_for(&root));

        assert_eq!(tabs_of(&tree), vec![vec!["files-1"], vec![]]);
        assert_eq!(gaps.len(), 1, "only the terminal was missing");
        assert_eq!(gaps[0].slot, PresetSlot::Terminal);
    }

    #[test]
    fn two_of_one_app_fill_two_slots_in_layout_order() {
        let root = builtins()[1].root.clone();
        let existing = vec![open("files-1", "files"), open("files-2", "files")];
        let (tree, gaps) = plan(&root, &existing, &mut ids_for(&root));

        assert_eq!(tabs_of(&tree), vec![vec!["files-1"], vec!["files-2"]]);
        assert!(gaps.is_empty(), "nothing had to be opened");
    }

    /// **The rule the whole feature turns on.** A surface the preset does not
    /// mention is still open afterwards.
    #[test]
    fn nothing_the_preset_did_not_mention_is_closed() {
        let root = builtins()[0].root.clone();
        let existing = vec![
            open("files-1", "files"),
            open("home-1", "home"),
            open("files-2", "files"),
        ];
        let (tree, gaps) = plan(&root, &existing, &mut ids_for(&root));

        let placed: Vec<&str> = tabs_of(&tree).concat();
        for e in &existing {
            assert!(
                placed.contains(&e.instance_id.as_str()),
                "{} is still on screen somewhere",
                e.instance_id
            );
        }
        assert_eq!(
            tabs_of(&tree),
            vec![vec!["files-1"], vec!["home-1", "files-2"]],
            "the extras land in the last pane, in the order they were in"
        );
        assert_eq!(gaps.len(), 1, "the terminal slot is still a gap");
    }

    #[test]
    fn a_terminal_already_in_the_tree_fills_a_terminal_slot() {
        let root = builtins()[0].root.clone();
        let existing = vec![terminal("term-4"), open("files-1", "files")];
        let (tree, gaps) = plan(&root, &existing, &mut ids_for(&root));

        assert_eq!(tabs_of(&tree), vec![vec!["files-1"], vec!["term-4"]]);
        assert!(
            gaps.is_empty(),
            "no second shell is spawned beside the one open"
        );
    }

    #[test]
    fn a_tab_that_resolves_to_nothing_does_not_fill_a_terminal_slot() {
        let root = builtins()[0].root.clone();
        let existing = vec![ghost("who-1"), open("files-1", "files")];
        let (tree, gaps) = plan(&root, &existing, &mut ids_for(&root));

        assert_eq!(gaps.len(), 1, "the terminal slot is still empty");
        assert_eq!(gaps[0].slot, PresetSlot::Terminal);
        assert_eq!(
            tabs_of(&tree),
            vec![vec!["files-1"], vec!["who-1"]],
            "and the unresolved tab is still on screen, still drawing its raw id"
        );
    }

    #[test]
    fn the_pane_a_preset_filled_shows_the_surface_it_asked_for() {
        let root = builtins()[0].root.clone();
        let existing = vec![open("files-1", "files"), open("home-1", "home")];
        let (tree, _) = plan(&root, &existing, &mut ids_for(&root));

        let PaneNode::Split { children, .. } = &tree else {
            panic!("expected a split");
        };
        let PaneNode::Leaf { active_tab, .. } = &children[0] else {
            panic!("expected a leaf");
        };
        assert_eq!(active_tab.as_deref(), Some("files-1"));
    }

    /// A gap in a pane that holds more than one slot has to say where it goes,
    /// because appending would put it after a surface that belongs behind it.
    #[test]
    fn a_gap_in_a_multi_slot_pane_carries_its_index() {
        let root = PresetNode::Pane {
            slots: vec![
                PresetSlot::Terminal,
                PresetSlot::App {
                    app_id: "files".to_string(),
                },
            ],
        };
        let existing = vec![open("files-1", "files")];
        let (tree, gaps) = plan(&root, &existing, &mut ids_for(&root));

        assert_eq!(tabs_of(&tree), vec![vec!["files-1"]]);
        assert_eq!(gaps.len(), 1);
        assert_eq!(
            gaps[0].index,
            Some(0),
            "the terminal belongs in front of it"
        );
    }

    #[test]
    fn every_pane_and_split_gets_an_id_of_its_own() {
        let root = builtins()[0].root.clone();
        assert_eq!(root.pane_count(), 2);
        assert_eq!(root.split_count(), 1);

        let (tree, _) = plan(&root, &[], &mut ids_for(&root));
        let PaneNode::Split { id, children, .. } = &tree else {
            panic!("expected a split");
        };
        assert_eq!(id, "split-1");
        assert_eq!(children[0].id(), "pane-1");
        assert_eq!(children[1].id(), "pane-2");
    }

    // --- capturing ----------------------------------------------------------

    fn slot_of_fixture(id: &str) -> Option<PresetSlot> {
        match id {
            "term-1" => Some(PresetSlot::Terminal),
            id if id.starts_with("files-") => Some(PresetSlot::App {
                app_id: "files".to_string(),
            }),
            id if id.starts_with("home-") => Some(PresetSlot::App {
                app_id: "home".to_string(),
            }),
            _ => None,
        }
    }

    #[test]
    fn capturing_a_tree_keeps_its_shape_and_its_apps_and_drops_its_ids() {
        let mut tree = PaneNode::leaf("pane-9");
        tree.insert_tab("pane-9", "files-1", None);
        tree.split_pane(
            "pane-9",
            SplitDir::Row,
            "split-4",
            "pane-10",
            "term-1",
            false,
        );
        tree.set_sizes("split-4", &[0.65, 0.35]);

        let captured = capture(&tree, &slot_of_fixture);

        assert_eq!(
            captured,
            builtins()[0].root,
            "the same arrangement, by shape"
        );
        let json = serde_json::to_string(&captured).expect("it serializes");
        assert!(!json.contains("pane-9"), "no pane id survives: {json}");
        assert!(!json.contains("term-1"), "no instance id survives: {json}");
    }

    #[test]
    fn a_tab_whose_surface_has_gone_is_not_captured() {
        let mut tree = PaneNode::leaf("pane-1");
        tree.insert_tab("pane-1", "files-1", None);
        tree.insert_tab("pane-1", "ghost-1", None);

        assert_eq!(capture(&tree, &slot_of_fixture), app_pane("files"));
    }

    #[test]
    fn capturing_a_cluster_with_nothing_open_is_an_empty_pane() {
        let tree = PaneNode::leaf("pane-1");
        assert_eq!(
            capture(&tree, &slot_of_fixture),
            PresetNode::Pane { slots: Vec::new() }
        );
    }

    /// A preset is written to disk and read back on the next launch, so one that
    /// serializes and does not deserialize is a preset that silently vanishes.
    #[test]
    fn a_preset_survives_a_json_round_trip() {
        for preset in builtins() {
            let json = serde_json::to_string(&preset).expect("a preset serializes");
            let back: LayoutPreset = serde_json::from_str(&json).expect("and reads back");
            assert_eq!(back.root, preset.root);
            assert_eq!(back.id, preset.id);
        }
    }

    #[test]
    fn the_wire_form_is_tagged_and_camel_cased() {
        let json = serde_json::to_string(&builtins()[0]).expect("serializes");
        assert!(
            json.contains(r#""kind":"split""#),
            "discriminated by `kind`: {json}"
        );
        assert!(
            json.contains(r#""kind":"terminal""#),
            "and so is a slot: {json}"
        );
        assert!(json.contains(r#""appId""#), "camelCase on the wire: {json}");
    }
}
