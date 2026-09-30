# Git, and a worktree per branch

*Projects and files · 7 min · after [Browsing and editing](files-and-editing.md)*

Read what changed, and give a branch a folder of its own.

---

If the cluster's project is a git repository, the **Git page** on the right-hand
rail is source control. It has two tabs, **Source Control** and **GitHub**.
Click the branch icon on the rail, press `Alt+1` or press `Ctrl+B` to open it,
and do the same again to close it.

> OpenKaava runs the `git` binary on your machine rather than linking a git
> library. That means your credential helper, SSH agent, `.gitconfig`, hooks
> and aliases all apply, because they are already `git`'s and nothing had to
> be taught about them.

## The change list

Two groups: **Staged Changes** and **Changes**. Click a file's control to
stage or unstage it; click the file itself to see its diff in the panel. A
clean checkout says **No changes**.

<!-- SCREENSHOT: the source control panel with staged and unstaged file groups, 480x800 -->

_M modified, A added, D deleted — the letter beside each file names its
kind._

1. Stage what you want in the commit.
2. Type a message into the **Commit message** field.
3. Press **Commit**. It stays disabled until something is staged _and_ the
   message is not empty.

The panel re-asks git after every change rather than watching the repository,
so what you see is what git said a moment ago rather than a live feed.

> **Not yet:** Push, pull, fetch and clone are not here. Each is
> long-running and reports progress, which wants the terminal rather than a
> panel — run them from an OpenKaava terminal, where your credentials already
> work.

## In the file apps

Changed files are marked in the File Explorer's tree, ignored files are
dimmed, and the File Viewer can show what changed inside a file against
`HEAD`. None of that needs turning on.

## The worktree offer

Open a git repository into a cluster that has no worktree yet and OpenKaava asks:
**Work in a separate worktree?**

A git worktree is a second checkout of the same repository, on its own
branch, in its own folder — one `.git` history, two working directories.
OpenKaava offers one because a **cluster** is meant to be an independent piece of
work, and two clusters sharing one checkout share one branch and one set of
uncommitted edits.

The dialog has two answers, and both are ordinary:

| Choice                       | What                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| Create worktree               | This cluster gets its own checkout and branch. Its edits never mix with anything else open on this repository. |
| Work in the project folder    | Decline. The cluster uses the repository as it is, on whatever branch is checked out.           |

The **Worktree name** field arrives pre-filled with a suggestion based on the
project's name, already selected, so accepting is one keystroke. It has to be
a usable folder name and one this repository is not already using; the
dialog says which rule you broke rather than refusing on submit.

> Decline when you are the only thing working on the repository — which is
> most of the time. Accept when you want a second cluster on a second branch
> at the same time. That is the case worktrees exist for, and the case where
> sharing one checkout goes wrong.

<!-- SCREENSHOT: two cluster tabs for the same project on two branches, one using a worktree, 480x300 -->

_Anvil and Anvil (review): one project, two clusters, two branches — only one
of them needed the worktree._

The offer only appears when the project is a repository **and** the cluster
has no worktree yet. It shows up after a successful open, not as a step the
open is waiting on — the project is already open behind it, and pressing
`Escape` leaves it that way.

A cluster on a worktree resolves everything against that checkout: its File
Explorer roots there, its terminals open there, and its search walks it. Its
change list changes too: instead of staged and unstaged files, it shows
everything the worktree has changed since it forked. Committed and
uncommitted work appear together, with no commit box.

## History

The panel can draw the commit graph as a lane diagram, newest at the top,
with the lines connecting each commit to its parents.

---

**Takeaway:** You can stage and commit from the panel, and decide — knowing
why — whether a cluster should get a worktree of its own.
