# Your first project

*Getting started · 6 min · after [The Veistra window](the-window.md)*

Open a folder, set it up as a Veistra project, and know what got written.

---

A Veistra project is **a folder**. Not a workspace file, not a database entry —
a directory on disk that you point Veistra at.

## Open one

<!-- SCREENSHOT: the Home screen's Start section, with Recents below it and one entry marked missing, 1440x900 -->

_**Start**, and **Recents** below it — one entry marked **missing**._

1. On the Home screen, click **Open Project** under **Start** (`Ctrl+O`). A
   native folder picker opens.
2. Pick any folder. It does not have to be a Veistra project, or a git
   repository, or empty.
3. Home now shows it at the top, under **Open**, with its full path.

> The picker is a native OS dialog and it blocks until you answer it. If Veistra
> looks frozen after clicking, check your other monitor — the button says
> **choose a folder…** while it waits, which is the only clue you get.

## A plain folder is a real project

A folder with no Veistra manifest still opens, and this is deliberate rather
than lenient. Veistra has to be able to point at a project that already exists,
and the answer to "what happens when the project format changes" must never
be "it stops opening".

Home marks such a folder **not set up** and offers a button: **Set up as a
Veistra project**. Nothing forces you to press it.

Open a plain folder → Home marks it **not set up** → Click **Set up as a Veistra project**

> **New Project** does the same thing to a folder it creates for you. No name
> field exists anywhere — the folder's own name becomes the project's, which
> is why renaming a project later means renaming the manifest file rather than
> editing a setting.

## What setting it up writes

Exactly two things, both at the top level of the folder. Nothing else,
anywhere.

<!-- SCREENSHOT: a file explorer showing Anvil.veistra and .veistra/ added beside a folder's existing files, 480x300 -->

_`Anvil.veistra` and `.veistra/`, added beside the files the folder already had._

1. A manifest named after the folder — a project called `Anvil` gets
   `Anvil.veistra`. Small, hand-editable TOML, meant for version control.
2. A `.veistra/` directory beside it. This is the opposite of the manifest:
   everything Veistra _produces_ about the project — agent traces, designs,
   docs — and it grows. It starts empty.

The manifest looks like this, comments and all:

```toml
[veistra]
# Bumped only when a change would make an older Veistra misread this file.
format = 1
created-with = "0.1.0"

[project]
# Stable across renames and moves.
id = "1806e1c4a5f30b80a4d1f39c77e2b510"
name = "Anvil"
created-unix-ms = 1755300000000
```

The `id` is the point of the file. It combines a creation timestamp with a
hash of that time and the path — not a UUID, because a dependency for one
value is a poor trade. It stays stable across renames and moves, and that is
what Veistra means when it says "this project": the path is not, since you will
move the folder eventually.

> The manifest takes the folder's name plus an extension, the way `.uproject`
> and `.sln` do. The manifest and the generated directory cannot share one
> name, and both want to be called after the project.

## Recents

The project you have open, and the last twenty before it, are remembered in
`projects.json` in the OS config directory. That is the only orchestrator
state that survives the process — everything else is worked out again at
boot.

A recent whose folder has since been deleted stays in the list, marked
**missing**, and cannot be opened. The `×` beside it removes it from the list;
nothing on disk is touched.

Opening a project does four things at once: it sets where the File Explorer
starts, where a new terminal opens, the OS window title, and what the next
launch restores.

## A project belongs to a cluster

Not to the application. Two clusters can have two different projects open at
the same time, and each one's File Explorer, terminals and search answer
about its own. See [Panes, tabs and clusters](panes-and-clusters.md).

> **Not yet:** **Clone Project** is drawn but does nothing, and says **soon**
> on the button. Cloning is a git operation with progress, authentication and
> partial-checkout failure, and that work is happening on its own branch.
> Clone the repository yourself and use **Open Project**.

---

**Takeaway:** You can open a folder as a project, and you know exactly which
two things Veistra wrote into it.
