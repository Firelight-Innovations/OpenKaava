# The app library

Long-form reasoning behind `catalog.toml`, `src-tauri/src/plugins/catalog.rs`,
and `scripts/check-catalog.mjs`. Follows the pattern of `backend-plugins.md`:
the modules carry short headers and point here for the argument.

## Three ways in, and only three

A user installs an app from the **library**, from a **GitHub repository they
name**, or from a **folder on their disk**. There is no fourth route, and the
three are deliberately not variations on one setting.

- The **library** is curation. It is the answer to "I am new here and I do not
  know what exists."
- A **repository URL** is the escape hatch. It is what makes the library a
  recommendation rather than a gate, and it is why nothing in the code refuses
  an install because the app is unlisted.
- A **folder** is the development path. It is how a tool author builds and
  tests an app against a local checkout before there is a release to point the
  library or a repository URL at, and it cannot be closed without making that
  workflow impossible. Schematify's two predecessor applications used to be
  the concrete case — both were meant to be developed against this path —
  but both are now folded into one in-repo app built by this repo's own
  toolchain (`apps/README.md`), so this path currently has no first-party app
  demonstrating it. It stays for the first genuinely third-party one.

## The library is not a permission boundary

Because the URL path exists, a curated list cannot stop anybody from installing
anything. Treating it as though it could would be worse than useless: it would
make every unlisted app look *broken* rather than *unlisted*, while stopping
nobody.

What the list actually controls is **discovery** and — the part that matters —
**what gets installed without being asked.**

## `default = true` is the dangerous field

An entry marked `default` is installed on first run, automatically, with nobody
asked. Combined with the fact that a plugin core is an unsandboxed child process
holding the user's full privileges (`tool-protocol.md` §6), that makes
`catalog.toml` the one file in this repository where **four lines of TOML cause
code to be downloaded and executed on every machine that installs Veistra.**

It is also the change most likely to be waved through in review, because it
looks like configuration rather than like code. That asymmetry — highest
consequence, lowest apparent weight — is the whole reason for the check below.

### First-run installs must fail quietly

A first run may have no network at all. A default install that cannot be fetched
is an ordinary outcome, not an error: it is logged, the app stays listed in the
library as available, and nothing alarming is shown. A shell that greets a new
user with two red failure notifications because they opened it on a plane has
made a worse first impression than one that simply has fewer apps.

## What the CI check protects, and what it does not

`scripts/check-catalog.mjs` fails a pull request that edits a guarded path
unless the author is the maintainer. The guarded paths are the catalog, the
script itself, and the workflow that runs it.

**It protects the ordinary case.** A contributor adds an entry; the merge is
blocked until the maintainer takes the change over. That is the case worth
automating, and the check handles it completely.

**It does not protect against a pull request that edits the check in the same
commit as the catalog.** A `pull_request` workflow runs the code from the pull
request's own head, so a check living in the tree can be neutered by the very
change it is checking. Guarding its own path makes that a *visible* act rather
than a silent one — the run fails, and deleting the workflow outright leaves a
required status check that never reports, which branch protection treats as
blocking rather than passing. But a sufficiently careful edit to the workflow
can still make it report green while doing nothing.

### The actual boundary is CODEOWNERS

GitHub evaluates CODEOWNERS **server-side**, where no commit inside the pull
request can reach it. `.github/CODEOWNERS` already claims `/.github/`, for
precisely the reason its own comment gives — *"a pull request that relaxes a
lint, widens a baseline, or edits the gate is a policy change wearing a
configuration change's clothes."*

Two things have to be true for that to bite, and as of 2026-08-21 neither is:

1. **"Require review from Code Owners" must be on** in `main`'s branch
   protection. It is currently off — `required_pull_request_reviews` is null, so
   CODEOWNERS is advisory and reviews are merely *requested*.
2. **The team it names must exist.** `.github/CODEOWNERS` assigns every guarded
   path to `@Firelight-Innovations/maintainers`, and that team does not exist —
   the org has no teams at all. A CODEOWNERS rule naming a team that cannot be
   resolved matches nobody, so today the file has no effect whatsoever.

Until both are fixed, `check-catalog.mjs` is the only thing standing here, and
it is the weaker half of the pair by design. The script is the fast, legible
signal that says *why* the build is red in one sentence; CODEOWNERS is the part
that cannot be edited from inside the pull request.

## Why the catalog is compiled in

`include_str!` rather than a file read at runtime, for the threat model rather
than for speed. A catalog sitting beside the executable is a file an installed
Veistra could be pointed at a different copy of; one baked into the binary changes
only when somebody ships a build, which is the same trust boundary as the rest
of the application code.

It also means the library renders on a machine that has never been online —
which matters, because consulting the catalog is among the first things a first
run does.

The cost is real and worth stating: **adding an app to the library requires a
Veistra release.** That is the trade being made, and it is the right one while the
list is short and the consequence of an entry is "runs code on every machine".
