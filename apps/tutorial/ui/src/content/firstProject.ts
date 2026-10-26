import type { Body } from "./blocks";

/**
 * Opening a folder, and what "set up as a Veistra project" actually writes.
 *
 * The second half matters more than the first. A tool that creates files in
 * somebody's repository owes them an exact list, and "initialize" is a word that
 * hides one.
 */
export const firstProject: Body = {
  takeaway:
    "You can open a folder as a project, and you know exactly which two things Veistra wrote into it.",
  blocks: [
    {
      kind: "text",
      body: "A Veistra project is **a folder**. Not a workspace file, not a database entry — a directory on disk that you point Veistra at.",
    },

    { kind: "heading", body: "Open one" },
    {
      kind: "mock",
      view: "home-start",
      caption: "**Start**, and **Recents** below it — one entry marked **missing**.",
    },
    {
      kind: "step",
      body: "On the Home screen, click **Open Project** under **Start**. A native folder picker opens.",
      chord: "Ctrl+O",
    },
    {
      kind: "step",
      body: "Pick any folder. It does not have to be a Veistra project, or a git repository, or empty.",
    },
    {
      kind: "step",
      body: "Home now shows it at the top, under **Open**, with its full path.",
    },
    {
      kind: "note",
      body: "The picker is a native OS dialog and it blocks until you answer it. If Veistra looks frozen after clicking, check your other monitor — the button says **choose a folder…** while it waits, which is the only clue you get.",
    },

    { kind: "heading", body: "A plain folder is a real project" },
    {
      kind: "text",
      body: 'A folder with no Veistra manifest still opens, and this is deliberate rather than lenient. Veistra has to be able to point at a game that already exists, and the answer to "what happens when the project format changes" must never be "it stops opening".',
    },
    {
      kind: "text",
      body: "Home marks such a folder **not set up** and offers a button: **Set up as a Veistra project**. Nothing forces you to press it.",
    },
    {
      kind: "flow",
      steps: [
        "Open a plain folder",
        "Home marks it **not set up**",
        "Click **Set up as a Veistra project**",
      ],
    },
    {
      kind: "note",
      body: "**New Project** does the same thing to a folder it creates for you. No name field exists anywhere — the folder's own name becomes the project's, which is why renaming a project later means renaming the manifest file rather than editing a setting.",
    },

    { kind: "heading", body: "What setting it up writes" },
    {
      kind: "text",
      body: "Exactly two things, both at the top level of the folder. Nothing else, anywhere.",
    },
    {
      kind: "mock",
      view: "project-files",
      caption: "`Anvil.veistra` and `.veistra/`, added beside the files the folder already had.",
    },
    {
      kind: "step",
      body: "A manifest named after the folder — a project called `Anvil` gets `Anvil.veistra`. Small, hand-editable TOML, meant for version control.",
    },
    {
      kind: "step",
      body: "A `.veistra/` directory beside it. This is the opposite of the manifest: everything Veistra *produces* about the project — agent traces, designs, docs — and it grows. It starts empty.",
    },
    {
      kind: "text",
      body: "The manifest looks like this, comments and all:",
    },
    {
      kind: "code",
      body: `[veistra]
# Bumped only when a change would make an older Veistra misread this file.
format = 1
created-with = "0.1.0"

[project]
# Stable across renames and moves.
id = "1806e1c4a5f30b80a4d1f39c77e2b510"
name = "Anvil"
created-unix-ms = 1755300000000`,
    },
    {
      kind: "text",
      body: 'The `id` is the point of the file. It combines a creation timestamp with a hash of that time and the path — not a UUID, because a dependency for one value is a poor trade. It stays stable across renames and moves, and that is what Veistra means when it says "this project": the path is not, since you will move the folder eventually.',
    },
    {
      kind: "note",
      body: "The manifest takes the folder's name plus an extension, the way `.uproject` and `.sln` do. The manifest and the generated directory cannot share one name, and both want to be called after the project.",
    },

    { kind: "heading", body: "Recents" },
    {
      kind: "text",
      body: "The project you have open, and the last twenty before it, are remembered in `projects.json` in the OS config directory. That is the only orchestrator state that survives the process — everything else is worked out again at boot.",
    },
    {
      kind: "text",
      body: "A recent whose folder has since been deleted stays in the list, marked **missing**, and cannot be opened. The `×` beside it removes it from the list; nothing on disk is touched.",
    },
    {
      kind: "text",
      body: "Opening a project does four things at once: it sets where the File Explorer starts, where a new terminal opens, the OS window title, and what the next launch restores.",
    },

    { kind: "heading", body: "A project belongs to a cluster" },
    {
      kind: "text",
      body: "Not to the application. Two clusters can have two different projects open at the same time, and each one's File Explorer, terminals and search answer about its own. See **Panes, tabs and clusters**.",
    },
    {
      kind: "soon",
      body: "**Clone Project** is drawn but does nothing, and says **soon** on the button. Cloning is a git operation with progress, authentication and partial-checkout failure, and that work is happening on its own branch. Clone the repository yourself and use **Open Project**.",
    },
  ],
};
