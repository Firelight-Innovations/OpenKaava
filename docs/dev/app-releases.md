# Releasing a Veistra app

What a repository outside this one has to publish for Veistra to install it.
`releases.md` is the orchestrator's own pipeline; this is the smaller one every
app repository needs, and the two differ in what they produce: Veistra ships an
`.exe` installer, an app ships a `.zip`.

Nothing uses this pipeline today. Schematify's two predecessor applications
used to be the concrete case it was written for — each was to own its own
copy of this, being separate parts of the stack maintained by separate teams,
where a shared pipeline would make one's release cadence the other's problem.
Both have since been folded into one in-repo app (`apps/README.md`) and
release through the orchestrator's own pipeline (`docs/dev/releases.md`)
instead. This document is what the first genuinely third-party tool
repository will need — kept for that case rather than deleted, the same way
`catalog.toml` and `veistra.toml` keep their machinery with zero rows.

## What Veistra downloads

`plugins::remote` resolves `https://api.github.com/repos/<owner>/<name>/releases/latest`
and looks for:

| Asset | Required | What it is |
|---|---|---|
| `*.zip` | **yes** | The built package. The first `.zip` on the release wins. |
| `<zip name>.sha256` | no | The zip's SHA-256. Verified before anything is unpacked. |

Without a `.zip`, the install fails with *"has no .zip asset attached"*. Without
the sidecar it still installs, but the record says `sha256: null` — "installed,
never verified" — so publish one.

The zip contains the package as Veistra will run it: `veistra-tool.toml` at the
root or one directory down, the built `ui/dist`, and the core binary at whatever
path `[core] bin` names. **Nothing is built on the user's machine.**

## The manifest

```toml
[tool]
id          = "acme-tool"
version     = "0.1.0"
name        = "Acme Tool"
description = "An example third-party tool, published outside this repository."

[frontend]
dist    = "ui/dist"
dev-url = "http://localhost:5174"    # pick a port per app; echo-tool has 5174

[[surface]]
id   = "main"
name = "Main"
path = "main/"

[core]
bin = "core/target/release/veistra-acme-tool.exe"
```

`[tool] id` **must** equal the `id` in `catalog.toml` for a library entry. A
release whose manifest disagrees is refused rather than installed under a name
it claims — see `plugins::install::run`.

## The workflow

Drop this in `.github/workflows/release.yml`. It mirrors the orchestrator's,
minus the installer step, plus the checksum.

```yaml
name: release

on:
  push:
    tags: ["v*"]
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version: 20
          cache: pnpm

      - name: Install Rust stable
        shell: bash
        run: |
          rustup toolchain install stable --profile minimal
          rustup default stable

      - uses: Swatinem/rust-cache@v2
        with:
          save-if: ${{ github.ref == 'refs/heads/main' }}

      - run: pnpm install --frozen-lockfile

      - name: Build the frontend
        run: pnpm --filter ./ui build

      - name: Build the core
        run: cargo build --release --manifest-path core/Cargo.toml

      # The zip is the package as Veistra runs it. Staged into a directory named
      # after the tag so the archive has one clean root, which is the shape
      # `remote::manifest_root` looks one level down for.
      - name: Stage and archive
        shell: bash
        run: |
          NAME="${{ github.event.repository.name }}-${{ github.ref_name }}"
          mkdir -p "staging/$NAME"
          cp veistra-tool.toml "staging/$NAME/"
          mkdir -p "staging/$NAME/ui"
          cp -r ui/dist "staging/$NAME/ui/dist"
          mkdir -p "staging/$NAME/core/target/release"
          cp core/target/release/*.exe "staging/$NAME/core/target/release/"
          mkdir -p artifacts
          (cd staging && 7z a -tzip "../artifacts/$NAME.zip" "$NAME")
          # sha256sum's own format: the digest, two spaces, the filename.
          # `remote::parse_checksum` reads that and the bare digest alike.
          (cd artifacts && sha256sum "$NAME.zip" > "$NAME.zip.sha256")
          ls -la artifacts

      - uses: actions/upload-artifact@v4
        if: ${{ !startsWith(github.ref, 'refs/tags/') }}
        with:
          name: package
          path: artifacts/
          retention-days: 14

      - name: Publish a draft release
        if: startsWith(github.ref, 'refs/tags/')
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          if gh release view "${{ github.ref_name }}" >/dev/null 2>&1; then
            gh release upload "${{ github.ref_name }}" artifacts/* --clobber
          else
            gh release create "${{ github.ref_name }}" artifacts/* \
              --draft \
              --title "${{ github.event.repository.name }} ${{ github.ref_name }}" \
              --generate-notes
          fi
```

Published as a **draft**, matching the orchestrator's. `releases/latest` ignores
drafts, so Veistra will not offer a release until somebody publishes it — which is
the intended safety on a pipeline that ships code onto other people's machines.

## Blocked: neither shared package is published yet

An app repository cannot currently depend on the two things the protocol says it
should, and this has to be settled before any such repository can build.

**`@veistra/bridge` is not on npm.** `npm view @veistra/bridge` is a 404, as of
2026-08-21. It is the only host coupling a plugin frontend is supposed to have —
`tool-protocol.md` §5 says a frontend's "only host coupling is `@veistra/bridge`",
and `.github/CODEOWNERS` calls it "the npm package a tool author actually
installs". Nothing installs it today, because it is not there.

**`veistra-rpc` is not on crates.io** either, though this half has a working
answer without publishing: a git dependency resolves fine against a public
repository.

```toml
veistra-rpc = { git = "https://github.com/Firelight-Innovations/Veistra.git" }
```

The frontend has no equivalent that is worth having. A git dependency on this
repository would fetch source, and `packages/bridge` publishes `dist` — which is
built, not committed — so it would need a `prepare` script and a build of the
whole workspace to install one small package.

**Recommendation: publish `@veistra/bridge` to npm before scaffolding the first
of these.** It is small, the repository is already public, and the protocol
document already describes it as published. Publishing `veistra-rpc` alongside it
is optional and tidier; the git dependency is a real answer for the Rust half
either way.
