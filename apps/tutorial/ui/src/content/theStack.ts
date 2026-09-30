import type { Body } from "./blocks";

/**
 * How the title bar's health badge reads a pinned stack of tools.
 *
 * The one tutorial with almost nothing to click. It is here because every other
 * page says "the stack" as though the reader already knows, and because a fresh
 * machine could, in principle, raise a warning badge over tools that are not
 * installed — which reads as breakage until you know none are meant to be
 * there yet. Today that principle is untested: `kaava.toml`'s `[[tool]]` array
 * is empty (Schematify, its former two entries folded into one, is an app
 * now — see `apps/README.md`), so the badge has nothing to report either way.
 */
export const theStack: Body = {
  takeaway:
    "You can find the stack's health in the title bar and tell a missing tool from a broken one.",
  blocks: [
    {
      kind: "text",
      body: "OpenKaava is not one program: an orchestrator that a **stack** of separate authoring tools can mount into, plus whatever ships compiled into the orchestrator itself. The orchestrator — the thing you are reading this in — is the one that ties a tool together with the rest when it runs, and it holds none of a tool's code.",
    },
    {
      kind: "text",
      body: "A tool's health is reported in the **title bar**, behind a warning triangle carrying a count. Clicking it lists the tools that are not well — and only those. A tool that is where it should be says nothing at all.",
    },
    {
      kind: "note",
      body: "So a stack with nothing wrong raises no badge. An empty result here is the healthy answer, not a screen that failed to load.",
    },
    {
      kind: "text",
      body: "The list lives in `kaava.toml` at the root of the orchestrator's checkout. Each entry pins an exact version, so a given checkout of the orchestrator always describes one reproducible stack rather than whatever each repository's branch tip happens to be today.",
    },

    { kind: "heading", body: "Nothing is pinned today" },
    {
      kind: "text",
      body: "`kaava.toml`'s `[[tool]]` array is empty right now. It held two entries once, and both are now the single Schematify app built into the orchestrator itself rather than separate tool repositories — see `apps/README.md` at the repository root for what it is now and why.",
    },
    {
      kind: "note",
      body: "The mechanism below still runs, with nothing to say about: an empty list reads exactly like a stack where every pinned tool matches its version, because that is what it is — a stack with nothing unwell in it.",
    },

    { kind: "heading", body: "Why the badge would say things are missing" },
    {
      kind: "flow",
      steps: [
        "Reads `kaava.toml`",
        "looks for each tool's checkout",
        "resolves one of four states",
      ],
    },
    {
      kind: "text",
      body: "Discovery resolves each checkout to one of four states, and the interface never shows the raw word for any of them. A checkout that matches the pin says nothing — that is the silent, healthy case. One that disagrees shows **needs update**. One with no version marker to read shows **not tracked**. One with nothing at the checkout path shows **not installed**.",
    },
    {
      kind: "mock",
      view: "stack-list",
      caption:
        "Two unwell tools and the count the badge carries. A healthy tool has no row here at all. Illustrative rather than live — nothing is pinned in kaava.toml today, so this exact screen has no current example to show.",
    },
    {
      kind: "text",
      body: "**Missing** and **broken** read differently once you know the words. `not installed` means nothing is at the checkout path; `needs update` means the checkout disagrees with the pin. `not tracked` means it is there, but carries no version to check at all.",
    },
    {
      kind: "text",
      body: "The orchestrator is usable entirely on its own regardless of what is pinned — Home, the File Explorer, the File Viewer, Tutorials, and Schematify are all in the binary and need no checkout at all. A pinned tool's checkout is a separate, additional thing to have on the machine, not a requirement for the window to open.",
    },
    {
      kind: "text",
      body: "`checkout-root` in `kaava.toml` says where a pinned tool's checkout is looked for, and defaults to `..` — every OpenKaava repository sitting as a sibling of the orchestrator's own folder. Cloning the pinned version there is what clears a tool from the badge; cloning the wrong one only changes which word it shows.",
    },

    { kind: "heading", body: "Apps and tools are different things" },
    {
      kind: "text",
      body: "Worth knowing, because they look identical once they are on screen — both are a tab in the switcher and a pane in the window.",
    },
    {
      kind: "text",
      body: "A **tool** is code the orchestrator finds: its own repository, its own release cadence, its frontend served from its own checkout and its core running as a separate process. It can be missing, unbuilt, or the wrong version — which is the whole reason a tool has states at all.",
    },
    {
      kind: "text",
      body: "An **app** is code the orchestrator *is*. Home, the File Explorer, the File Viewer, this Tutorials pane, and Schematify are apps: they are compiled into the binary. That leaves no version to disagree with and no way for one to be missing — which is why none of them can ever raise the badge.",
    },
  ],
};
