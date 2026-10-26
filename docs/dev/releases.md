# Releases and updates

A release is cut from a **tag**, built on GitHub, and published as a **draft**
that a person reviews before it goes out. An installed Veistra finds the next one
by itself, if — and only if — the release it came from was built with the
updater signing key. Nothing is code-signed, which is a different absence and is
described at the bottom rather than left to be discovered.

## Cutting one

```sh
node scripts/check-version.mjs --set 0.2.0   # writes package.json + Cargo.toml
cargo update -w                              # Cargo.lock carries the version too
pnpm verify                                  # the gate, as always
git commit -am "Release 0.2.0"
git push
git tag v0.2.0
git push origin v0.2.0
```

The tag push is what starts `.github/workflows/release.yml`. It builds on
`windows-latest`, and roughly fifteen minutes later a **draft** release is
waiting at `/releases` with the MSI and the NSIS setup attached. Read the
generated notes, edit them, press publish.

The draft is the review step. A tag push on its own has none, and a published
release with wrong notes cannot be quietly fixed once people have the link.

### Trying it without a tag

`release.yml` also answers `workflow_dispatch`. Run it from the Actions tab and
it performs the same build, then hangs the installers off the workflow run as
artifacts for a fortnight instead of publishing anything. Use it when changing
the workflow, because the alternative way to test a release build is to push a
tag, and a tag is the one thing in this process that cannot be taken back
cleanly.

## Where the version lives

**`package.json` is the only place to edit it.** Everything else either
inherits or is checked, and `pnpm lint` fails on a disagreement.

| Place | How |
|---|---|
| `package.json` | the source of truth |
| `src-tauri/tauri.conf.json` | `"version": "../package.json"`, read by Tauri itself |
| `src-tauri/Cargo.toml` | `version.workspace = true` |
| `Cargo.toml` | `[workspace.package]`, **checked** — Cargo cannot indirect |

Only the last one is a copy, because Cargo has no way to read a version out of
another file. `scripts/check-version.mjs` compares it against `package.json` on
every `pnpm lint`, and `--set` writes both at once so the two cannot be bumped
apart by hand.

The script also asserts that the two indirections are still indirections. A
commit that replaced `"../package.json"` with a literal would look like a
simplification and would silently restore the drift the check exists to
prevent, so that specific edit fails the lint.

The release workflow runs the same script with `--tag`, before it builds
anything. A tag that disagrees with `package.json` would produce installers
whose filenames state a version that is not the one compiled into them, and
nothing about the finished artifact reveals that. It fails at the top of the
job instead.

## Building one by hand

```sh
pnpm app:build
```

The same command CI runs. It compiles the frontend to static files, embeds them
in an optimized Rust binary, and produces installers under `target/release/`.
The release profile has no cheap incremental rebuild, so expect minutes.

| Path | What |
|---|---|
| `veistra-orchestrator.exe` | the app, self-contained |
| `bundle/nsis/Veistra_<ver>_x64-setup.exe` | the installer |

**One installer, not two.** `bundle.targets` is `["nsis"]` rather than `"all"`,
so no MSI is built. Two downloads on a release page is a choice a first-time
visitor has to make and has no basis for making, and the wizard is the one that
suits a person rather than a deployment tool. MSI is worth adding back the day
somebody wants to push Veistra out over group policy, and not before.

The workflow uploads the installer twice: once under its versioned name, and
once as `Veistra-setup.exe`. The second is what makes
`/releases/latest/download/Veistra-setup.exe` a link that never breaks, which is
what the README's download button points at.

Those filenames come from `productName` in `tauri.conf.json`, which is checked
against `branding.toml` — renaming the product renames the installers with it.

This page used to add that the bundle identifier does not change, and that
therefore nobody's projects or settings move. Both halves were false by the
time anybody read them: the rename from HELVE to OpenKaava (now Veistra) moved
the identifier and orphaned a live `%APPDATA%` directory, and it moved
`productName` too, which is what installed OpenKaava beside HELVE instead of over
it. Nothing was watching
either value. `pnpm lint:identity` now is, and `docs/dev/user-data.md` is where
the whole subject lives — what user data is at risk, what a rename costs, and
what to run when one is deliberate.

WiX and NSIS are downloaded automatically on the first release build. The
workflow does not cache them, or the Rust `target/` directory: release-profile
artifacts are a separate cache entry from the dev-profile ones that gate every
pull request, GitHub evicts at 10 GB per repository, and a release runs a
handful of times a month. Paying a cold build for the thing people download
beats making the gate everyone waits for miss its cache.

## What the installer does besides copying files

`src-tauri/installer-hooks.nsh` runs on install and on uninstall, and it exists
for one feature: **Open with Veistra** in Explorer's context menu, on folders, on
the background of an open folder, and on files.

Those are three registry keys under `HKCU\Software\Classes`. HKCU rather than
HKLM is forced rather than chosen: `installMode` is `currentUser`, so the
installer runs without administrator rights and has no write access to HKLM. It
also means the uninstaller can remove exactly what it wrote.

The command differs by one character between the three, and getting it wrong
produces a menu entry that opens the wrong thing without erroring. `%1` is the
item clicked. `%V` is the folder being viewed, which is the only thing a
background click can mean.

`src-tauri/src/launch.rs` is the other half: it reads the path off the command
line, decides whether it is a folder or a file, and opens the folder as a
project. It also registers `tauri-plugin-single-instance`, and that is not
optional. Without it, "Open with Veistra" on a second folder starts a second
process, and two processes writing `layout.json` and `projects.json` is data
loss rather than a glitch.

## The updater

An installed Veistra checks once per launch — in the background, after everything
else in `lib.rs`'s setup — and again whenever somebody picks **Help ▸ Check for
Updates**. What it finds appears as one line in the status bar and nowhere else:
no dialog, no toast, nothing that takes the screen away from what it was
showing. Nothing is downloaded until that line is clicked.

`updates.checkAutomatically` in Settings turns the launch check off. It does not
turn the menu item off, and neither of them ever installs anything on its own.

| Piece | Where |
|---|---|
| the check, the download, the installer | `src-tauri/src/updater.rs` |
| the status bar line, and when it stays silent | `updateNotice` in `src/shell/contract.ts` |
| the endpoint and the public key | `plugins.updater` in `src-tauri/tauri.conf.json` |
| the manifest the endpoint serves | `scripts/update-manifest.mjs` |

The endpoint is `/releases/latest/download/latest.json`, which is why releases
are not marked prerelease — see the last bullet at the bottom. Publishing the
draft is what makes that URL start serving the new manifest, so an update is
offered at the moment a person decides it is ready and not when a tag was
pushed.

`plugins.updater.windows.installMode` is `passive`, which is also Tauri's
default and is pinned anyway: it is the one part of an update the user actually
watches — a progress window that needs no clicks — and an upstream default
moving to `quiet` or `basicUi` would change that silently.

### The signing key, and why the flag is not in `tauri.conf.json`

Update artifacts are signed with a **minisign** keypair. It is free, it is
generated once, and it is unrelated to the code signing certificate the bottom
of this page is about: minisign proves an update came from whoever holds this
repository's release key, and says nothing at all to SmartScreen.

`bundle.createUpdaterArtifacts` is the flag that produces the signed artifacts,
and `tauri build` **fails outright** when it is set and no key is in the
environment. Setting it in `tauri.conf.json` would therefore break `pnpm
app:build` for everyone who is not the release workflow. So it lives in
`src-tauri/tauri.updater.conf.json` instead, merged over the real config with
`--config`, and only on the branch of `release.yml` that has the secret:

```sh
pnpm app:build --config src-tauri/tauri.updater.conf.json   # needs the key
pnpm app:build                                              # always works
```

The workflow gates on `TAURI_SIGNING_PRIVATE_KEY` being non-empty rather than on
a `secrets` lookup, because a workflow cannot read `secrets` in a step's `if:`.
A release built without it still publishes installers; it simply publishes no
`latest.json`, and no installed Veistra will offer that version.

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is set from a secret that may not exist, in
which case Actions supplies an empty string — and an empty string is exactly
what a key with no password wants. **A variable that is absent is not the same
as one that is empty**: absent, the CLI prints "expect a prompt for password"
and waits forever on a runner nobody can type into.

That difference bites locally on Windows, because `$env:X = ""` in PowerShell
*deletes* the variable rather than emptying it. A signed build by hand wants
bash — `export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=` — or a `-p ""` on the
command.

### Creating the secret

Once, by whoever owns the repository. The private half must never be committed.

```sh
pnpm tauri signer generate -w "$HOME/.veistra/updater.key"
gh secret set TAURI_SIGNING_PRIVATE_KEY < "$HOME/.veistra/updater.key"
# only if the key was given a password:
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Then paste the contents of `updater.key.pub` into `plugins.updater.pubkey` in
`tauri.conf.json` and commit *that* half. The two have to be generated together:
a build signed with a key whose public half is not in the shipped binary
produces updates every installed copy downloads and then refuses.

**Losing the private key is not recoverable.** Every already-installed Veistra
carries the public half compiled in, so a new keypair means those copies stop
accepting updates and have to be reinstalled by hand.

## The installed build cannot find a stack

**This is the one caveat that will be mistaken for a bug.** `bundle.resources`
ships a copy of `veistra.toml`, but its `checkout-root = ".."` resolves relative
to wherever the manifest ends up — which is the install directory, not your
code tree. `locate()` searches in this order:

1. `$VEISTRA_MANIFEST`
2. the repo root (dev builds only, via `CARGO_MANIFEST_DIR`)
3. a `veistra.toml` placed next to the installed executable
4. the copy bundled into the app

Steps 1 and 3 are the ones that make an installed build useful. Until the
orchestrator can be pointed at a workspace directly, an installed copy reports
every tool as `not cloned`, and that reading is correct. Run from the repo to
see a stack resolve. `.github/release-preamble.md` says so on every release, so
the answer arrives with the download rather than after a bug report.

## What still does not exist

- **No code signing.** The MSI and the setup.exe are unsigned, so Windows
  SmartScreen shows "Windows protected your PC" and hides the Run button behind
  **More info**. A certificate is a purchase rather than a configuration:
  Azure Trusted Signing is the cheap route but wants an organization identity
  with some history behind it, and an OV or EV certificate runs to a few hundred
  a year. When one exists it arrives as a repository secret and `release.yml`
  gains two `env:` lines. That is why signing is absent from the workflow
  rather than stubbed out in it.
- **No update signing key yet.** The updater is wired end to end, but
  `TAURI_SIGNING_PRIVATE_KEY` does not exist as a repository secret, so every
  release until it does ships installers and no `latest.json`. See "Creating the
  secret" above; it is one command and a commit.
- **No rollback, and no channels.** There is one endpoint and it always names
  the newest published release. Going back a version means downloading the
  installer for it from `/releases` by hand.
- **Releases are not marked prerelease.** `0.1.x` and the status badge already
  say pre-alpha, and marking them would stop `/releases/latest` resolving —
  which is both the stable download URL worth having and, now, the URL the
  updater's endpoint is built on. Marking one release prerelease would take
  every installed Veistra off the update path silently.
