import type { Body } from "./blocks";

/**
 * Source control, and the worktree offer.
 *
 * The worktree half is the one worth the tutorial. Veistra offers a worktree on
 * the first open of a repository, which is a prompt most people have never seen
 * from an editor — and declining it is the right answer often enough that the
 * dialog needs explaining rather than just answering.
 */
export const gitAndWorktrees: Body = {
  takeaway:
    "You can stage and commit from the panel, and decide — knowing why — whether a cluster should get a worktree of its own.",
  blocks: [
    {
      kind: "text",
      body: "If the cluster's project is a git repository, the **secondary panel** on the right of the tool window is source control. `Ctrl+B` collapses it to a strip and brings it back.",
    },
    {
      kind: "note",
      body: "Veistra runs the `git` binary on your machine rather than linking a git library. That means your credential helper, SSH agent, `.gitconfig`, hooks and aliases all apply, because they are already `git`'s and nothing had to be taught about them.",
    },

    { kind: "heading", body: "The change list" },
    {
      kind: "text",
      body: "Two groups: **Staged Changes** and **Changes**. Click a file's control to stage or unstage it; click the file itself to see its diff in the panel. A clean checkout says **No changes**.",
    },
    {
      kind: "mock",
      view: "source-control",
      caption: "M modified, A added, D deleted — the letter beside each file names its kind.",
    },
    {
      kind: "step",
      body: "Stage what you want in the commit.",
    },
    {
      kind: "step",
      body: "Type a message into the **Commit message** field.",
    },
    {
      kind: "step",
      body: "Press **Commit**. It stays disabled until something is staged *and* the message is not empty.",
    },
    {
      kind: "text",
      body: "The panel re-asks git after every change rather than watching the repository, so what you see is what git said a moment ago rather than a live feed.",
    },
    {
      kind: "soon",
      body: "Push, pull, fetch and clone are not here. Each is long-running and reports progress, which wants the terminal rather than a panel — run them from a Veistra terminal, where your credentials already work.",
    },

    { kind: "heading", body: "In the file apps" },
    {
      kind: "text",
      body: "Changed files are marked in the File Explorer's tree, ignored files are dimmed, and the File Viewer can show what changed inside a file against `HEAD`. None of that needs turning on.",
    },

    { kind: "heading", body: "The worktree offer" },
    {
      kind: "text",
      body: "Open a git repository into a cluster that has no worktree yet and Veistra asks: **Work in a separate worktree?**",
    },
    {
      kind: "text",
      body: "A git worktree is a second checkout of the same repository, on its own branch, in its own folder — one `.git` history, two working directories. Veistra offers one because a **cluster** is meant to be an independent piece of work, and two clusters sharing one checkout share one branch and one set of uncommitted edits.",
    },
    {
      kind: "text",
      body: "The dialog has two answers, and both are ordinary:",
    },
    {
      kind: "keys",
      rows: [
        {
          chord: "Create worktree",
          what: "This cluster gets its own checkout and branch. Its edits never mix with anything else open on this repository.",
        },
        {
          chord: "Work in the project folder",
          what: "Decline. The cluster uses the repository as it is, on whatever branch is checked out.",
        },
      ],
    },
    {
      kind: "text",
      body: "The **Worktree name** field arrives pre-filled with a suggestion based on the project's name, already selected, so accepting is one keystroke. It has to be a usable folder name and one this repository is not already using; the dialog says which rule you broke rather than refusing on submit.",
    },
    {
      kind: "note",
      body: "Decline when you are the only thing working on the repository — which is most of the time. Accept when you want a second cluster on a second branch at the same time. That is the case worktrees exist for, and the case where sharing one checkout goes wrong.",
    },
    {
      kind: "mock",
      view: "worktree-list",
      caption:
        "Anvil and Anvil (review): one project, two clusters, two branches — only one of them needed the worktree.",
    },
    {
      kind: "text",
      body: "The offer only appears when the project is a repository **and** the cluster has no worktree yet. It shows up after a successful open, not as a step the open is waiting on — the project is already open behind it, and pressing `Escape` leaves it that way.",
    },
    {
      kind: "text",
      body: "A cluster on a worktree resolves everything against that checkout: its File Explorer roots there, its terminals open there, and its search walks it. Its change list changes too: instead of staged and unstaged files, it shows everything the worktree has changed since it forked. Committed and uncommitted work appear together, with no commit box.",
    },

    { kind: "heading", body: "History" },
    {
      kind: "text",
      body: "The panel can draw the commit graph as a lane diagram, newest at the top, with the lines connecting each commit to its parents.",
    },
  ],
};
