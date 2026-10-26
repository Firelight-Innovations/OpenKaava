# Using Veistra

This section is for someone who wants to *run* Veistra, not build it. If you
want to contribute code instead, see [the developer docs](../dev/README.md).

## What Veistra is

Veistra is an **ADE** — an Agentic Development Environment. It is one shell
that a stack of authoring tools mount into, the way VS Code is one shell that
extensions mount into. `README.md` at the repository root has the full
picture of the stack; the short version is that this repository — the
**orchestrator** — is the shell, and a genuinely separate tool is its own
project that plugs into it, pinned by version in `veistra.toml`.

Schematify (the design layer — the technical and product plan together) is not
that kind of tool: it ships as an app built into the orchestrator itself,
alongside Home and the File Explorer, rather than as a separate project — see
[`apps/README.md`](../../apps/README.md) at the repository root. Today the
orchestrator itself is what runs: the window, Home, the File Explorer, the
File Viewer, and Tutorials, with Schematify still unbuilt behind its tab.
[The stack, end to end](tutorials/the-stack.md) covers the
switcher bar's health badge, for whichever tool is pinned in `veistra.toml` next.

## Getting it running

[Download the installer](https://github.com/Firelight-Innovations/Veistra/releases/latest/download/Veistra-setup.exe)
and run it. It installs for your account only. It never asks for
administrator rights. Windows SmartScreen will warn about it, because it is
not signed. Click **More info**, then **Run anyway**.

Veistra runs on Windows only. To build it from source instead, the root
[README.md](../../README.md#build-from-source) has the prerequisites; the
short version is `pnpm install` then `pnpm app`.

## Learning your way around

[Tutorials](tutorials/README.md) is ten short pages, the same ones the
Tutorials app inside Veistra shows you. Start with **The Veistra window** if
you've never opened it before — it names the parts of the frame that every
other tutorial refers to without re-explaining.

## Found a problem, or want something that isn't here?

Open an issue on GitHub. `.github/ISSUE_TEMPLATE/bug_report.yml` and
`feature_request.yml` are there for exactly that.
