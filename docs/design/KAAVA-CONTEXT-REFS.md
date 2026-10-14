# `kaava://` references and the context server

Status: in progress (2026-10-14). Code: `src-tauri/src/refs/`, and from PR 2
`src-tauri/src/mcp/servers/context.rs`.

This is the two-way context layer between a person and an agent. A person can point the agent at a
file, an asset, a canvas frame, a comment or a screenshot. An agent can point the person at the
same things, and the agent tab draws them inline. Both sides use one reference scheme.

It replaces the planned `kaava-show` server and widens the Kaava tool server of
`docs/handoffs/agent-host.md` §3.6. It builds on `KAAVA-AGENT-CONTEXT.md` §7, which sketched
`kaava-context` for terminal agents. Unlike the developer servers, it is served with developer
mode off, behind its own switch in Settings → MCP servers.

Status of each part:

| Part                                              | Where                          | State   |
| ------------------------------------------------- | ------------------------------ | ------- |
| Scheme, policy, resolver, `refs/resolve`          | `src-tauri/src/refs/`          | PR 1    |
| `kaava-context` server: `show`, search, resources | `src-tauri/src/mcp/servers/`   | PR 2    |
| `refs/search` and `refs/prompt` for the @ picker  | `src-tauri/src/refs/`          | PR 3    |
| Component catalogue and `show_component`          | server and the tab's renderers | PR 4    |

## 1. The scheme

| Reference                          | Points at                                                          |
| ---------------------------------- | ------------------------------------------------------------------ |
| `kaava://file/<path>`              | A file, asset or folder, relative to the cluster's root            |
| `kaava://file/<path>#L10-L20`      | Lines 10 to 20 of it (`#L10` for one line; `#L10-20` also parses)  |
| `kaava://canvas/<id>`              | A canvas. Ids may nest: `kaava://canvas/levels/hospital`           |
| `kaava://canvas/<id>#frame=<id>`   | One frame on it, by element id or exact name                       |
| `kaava://canvas/<id>#comment=<id>` | One comment on it                                                  |
| `kaava://comment/<id>`             | A viewer comment (`.kaava/comments/`) and its screenshot           |
| `kaava://design-comment/<id>`      | A Design Mode comment and its screenshot (design-mode builds only) |
| `kaava://context/<id>`             | An item in the context store (`.kaava/context/`)                   |
| `kaava://selection`                | What is selected in the cluster's panes, read when it is resolved  |

Rules:

1. The scheme is case-insensitive. The rest is not.
2. Path segments are percent-encoded. `parse` decodes them, and `Display` writes the one canonical
   form, so a reference written twice compares equal.
3. A path must be relative, with `/` separators. Empty, `.` and `..` segments are refused, and so
   are `\`, `:`, drive letters, reserved device names, and trailing dots or spaces. The parser
   refuses them before anything touches the disk.
4. Ids for comments, design comments and context items are a single segment of letters, digits,
   `-` and `_`.
5. `kaava://canvas/<id>` is already the link the canvas writes for a subcanvas, so canvas links
   are references as they stand. `kaava://workspace/focus` stays the workspace server's resource.

## 2. Resolving

A reference resolves inside one cluster, the cluster of whoever is asking. The result is a
`Resolved`:

```json
{
  "uri": "kaava://file/scripts/player.gd#L10-L20",
  "kind": "text",
  "title": "player.gd",
  "detail": "scripts/player.gd · lines 10–20",
  "meta": { "size": 4210, "mime": "text/plain", "modified": 1760400000000 },
  "parts": [{ "type": "text", "text": "…", "language": "gdscript", "startLine": 10, "truncated": false }],
  "withheld": null
}
```

`kind` is one of `text`, `image`, `model`, `scene`, `audio`, `video`, `binary`, `folder`, `canvas`,
`frame`, `comment`, `design-comment`, `context` or `selection`. A part is one of these:

- `text`: carries `language` and `startLine`.
- `image`: carries base64 data.
- `json`: structured data such as a frame's properties or a comment's thread.
- `note`: a sentence such as "audio file, 2.1 MB; no preview".

The tab draws parts. The MCP server turns them into content blocks. The @ picker turns them into
ACP prompt blocks.

| Kind           | What the parts carry                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- |
| text, scene    | An excerpt: the asked range, else the file's start (a binary scene gets a note)          |
| image          | The image, if PNG, JPEG, GIF, WebP or SVG and under the cap; otherwise a note            |
| model          | Header facts (`.glb`, `.gltf`: meshes, materials, animations, generator) and a note      |
| audio          | WAV format and length; other formats a note                                              |
| folder         | Its entries, folders first; secrets and gitignored entries are counted, not named        |
| canvas         | Its frames, each with its own reference                                                  |
| frame          | The frame's type, properties and text, and its picture when a Canvas pane can render it  |
| comment        | The comment's text, the comment as JSON, and its screenshot                              |
| design-comment | The request, the page and element as JSON, and the screenshot                            |
| context        | The stored item, read the same way as a file                                             |
| selection      | The selected text, each visible app's report, and references to what the apps name       |

## 3. Security

1. **Only inside the cluster.** The root is the cluster's environment, worktree or project. The
   root and the target are both canonicalised, so symlinks and junctions are followed, and the
   target must still start with the root. A link that leads out is refused.
2. **Secrets are never read.** A path is withheld, never served, if it or its resolved target
   matches one of these rules:
   - `.env`, `.envrc`, `.env.*` and `*.env`. The templates `.env.example`, `.env.sample`,
     `.env.template`, `.env.dist` and `.env.defaults` are allowed.
   - Private keys and key stores: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.p8`,
     `*.ppk`, `*.kdbx`, and SSH keys `id_*` (except `.pub`).
   - Credential files: `.npmrc`, `.pypirc`, `.netrc`, `_netrc`, `.git-credentials`, `.htpasswd`,
     `credentials*`, `secrets.*`, `client_secret*`, `keystore.properties`, Godot's
     `export_credentials.cfg`, `*.tfvars` and `*.tfstate`.
   - Anything under `.git/`, `.ssh/`, `.aws/`, `.gnupg/`, `.azure/`, `.kube/` or `.docker/`.

   A withheld result says which rule matched. A folder counts these entries and does not name
   them, and search (PR 3) does not list them.
3. **Gitignored files are named, not read.** Kaava's own stores have their own reference kinds,
   which do not apply this rule. Everything else that `.gitignore` excludes, such as build output,
   caches and local config, resolves to `withheld`.
4. **Caps.** An excerpt holds at most 1,000 lines and 64 KB. A file is scanned at most 16 MB deep
   for a range. An image is sent inline only up to 3.5 MB, which is about 4.7 MB in base64, under
   a provider's 5 MB per image.
5. **The token is per launch (PR 2).** A tab session's server entry carries a token bound to that
   cluster. The token is accepted only on `/mcp/context`. It is never the master token, which also
   reaches the developer servers.
6. **The canvas does its own checks.** Canvas, frame and canvas-comment references go through the
   Canvas app's methods, which resolve canvas ids inside the same root. A rendered picture is read
   only when the path the canvas returns is inside the root.

## 4. Host methods

The shell answers these methods for any app, from the calling surface's cluster, the same way it
answers `context/*`:

| Method         | Params                      | Result                                       | State |
| -------------- | --------------------------- | -------------------------------------------- | ----- |
| `refs/resolve` | `{ uri }`                   | `Resolved`                                   | PR 1  |
| `refs/search`  | `{ query, kinds?, limit? }` | `{ items: [{ uri, kind, title, detail }] }`  | PR 3  |
| `refs/prompt`  | `{ uris }`                  | `{ blocks: AcpContentBlock[] }`              | PR 3  |

`refs/resolve` resolves as the person: the canvas records `human` as the actor on the calls it
makes. It sits before the write refusal in `apps::call`, so it works on a read-only main.
