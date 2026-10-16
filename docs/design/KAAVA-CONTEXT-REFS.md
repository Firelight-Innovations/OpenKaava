# `kaava://` references and the context server

Status: in progress (2026-10-14). Code: `src-tauri/src/refs/`, and from PR 2
`src-tauri/src/mcp/servers/context.rs`.

This is the two-way context layer between a person and an agent. A person can point the agent at a
file, an asset, a canvas frame, a comment or a screenshot. An agent can point the person at the
same things, and the agent tab draws them inline. Both sides use one reference scheme.

It widens the Kaava tool server of `docs/handoffs/agent-host.md` §3.6. That server's reads
(`get_selection`, `list_comments`, `get_canvas_node`) become references and the tools that resolve
them. `show` adds the direction §3.6 has no tool for: the agent pointing the person at something.
It builds on `KAAVA-AGENT-CONTEXT.md` §7, which sketched `kaava-context` for terminal agents. Unlike the developer servers, it is served with developer
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
   `-` and `_`. A canvas comment's id is one the Canvas app makes: lowercase letters, digits and
   `-`.
5. A canvas is named by the id the Canvas app opens it by: lowercase slug segments, without a
   leading `canvas/` or a `.json`. `kaava://canvas/canvas/x.json` is refused and names
   `kaava://canvas/x`, so the file that is checked is the file the app opens.
6. `kaava://canvas/<id>` is already the link the canvas writes for a subcanvas, so canvas links
   are references as they stand. `kaava://workspace/focus` stays the workspace server's resource.

## 2. Resolving

A reference resolves inside one cluster, the cluster of whoever is asking. Design Mode comments
are the one exception. They belong to the running app, not to a cluster, so any cluster with a
project open resolves the same ones. The result is a `Resolved`:

```json
{
  "uri": "kaava://file/scripts/player.gd#L10-L20",
  "kind": "text",
  "title": "player.gd",
  "detail": "scripts/player.gd · lines 10–20",
  "meta": { "size": 4210, "mime": "text/plain", "modified": 1760400000000 },
  "parts": [{ "type": "text", "text": "…", "language": "gdscript", "startLine": 10, "truncated": false }]
}
```

`detail` and `withheld` are left out when they are not set. `withheld` says why nothing, or less,
was read: a secret, a gitignored file, or a file over a cap.

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
| image          | The image if PNG, JPEG, GIF or WebP, an SVG as its text; over the cap it is withheld     |
| model          | Header facts (meshes, materials, animations, generator); `.gltf` excerpt, `.glb` note    |
| audio          | WAV format and length; other formats a note                                              |
| folder         | Its entries, folders first; secrets and gitignored entries are counted, not named        |
| canvas         | Its frames, each with its own reference; a canvas that cannot be read is an error        |
| frame          | The frame's type, properties and text, and its picture when a Canvas pane can render it  |
| comment        | The comment's text, the comment as JSON, and its screenshot                              |
| design-comment | The request, the page, selector and thread as JSON, and the screenshot or why it is not  |
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
     `*.ppk`, `*.kdbx`, and SSH keys: `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`, and any
     other `id_*` with no extension (`.pub` is allowed).
   - Credential files: `.npmrc`, `.pypirc`, `.netrc`, `_netrc`, `.git-credentials`, `.htpasswd`,
     `.pgpass`, `.my.cnf`, `credentials*`, `secrets.*`, `client_secret*`, `*kubeconfig`,
     `keystore.properties`, Godot's `export_credentials.cfg`, and anything with `.tfvars` or
     `.tfstate` in its name (so `terraform.tfstate.backup` too).
   - Token stores: OpenKaava's own `mcp-endpoint.json`, `.vault-token`,
     `application_default_credentials.json`, `.terraformrc`, `terraform.rc`, `.s3cfg`, `.boto`,
     `.dockercfg`, `gh/hosts.yml` and `service-account*.json`.
   - Anything under `.git/`, `.ssh/`, `.aws/`, `.gnupg/`, `.azure/`, `.kube/` or `.docker/`.

   A file is also withheld, whatever it is called, when its first 64 KB hold a private key: a
   `-----BEGIN … PRIVATE KEY-----` header that ends its line or has an escaped line break after
   it (so a key inside a JSON, YAML or env value too), a PuTTY key header, or an age secret key. A
   context item copied in from outside the project is checked by the path it was copied from and
   the copy's name. Its title is free text, so it counts only when it is spelt as a file name,
   with no spaces.

   A withheld result says which rule matched. A folder counts these entries and does not name
   them, and search does not list them.
3. **Gitignored files are named, not read.** Kaava's own stores have their own reference kinds,
   which do not apply this rule. Everything else that `.gitignore` excludes, such as build output,
   caches and local config, resolves to `withheld`. The rules follow git's: a folder that is
   excluded stays excluded, so a `!` line cannot re-include a file under it. A line that does not
   parse costs only that line. Patterns ignore case on Windows and macOS, where `core.ignorecase`
   is on by default. In a linked worktree, which a cluster usually is, `info/exclude` is read
   from the shared git dir.
4. **Caps.** An excerpt holds at most 1,000 lines and 64 KB, and so does an app's prose, such as
   a comment's text. A JSON part is at most 64 KB written out; a larger one is a note giving its
   size. A file is scanned at most 16 MB deep for a range, and a folder at most 5,000 entries
   deep. An image is sent inline only up to 3.5 MB, which is about 4.7 MB in base64, under a
   provider's 5 MB per image.
5. **The token is per launch.** A tab session's server entry carries a token bound to that
   cluster. The token is accepted only on `/mcp/context`, and every call made with it answers from
   that cluster, whatever `cluster` it names. It is never the master token, which also reaches the
   developer servers. Tokens live in memory, so a restart mints new ones.
6. **Canvases pass the same test.** Canvas, frame and canvas-comment references go through the
   Canvas app's methods, which read the canvas file where they find it. So before any of them is
   called, these must be inside the root once links are followed: the canvas file, each child
   canvas its split frames moved their elements into, and a comment's own file, which may have
   moved into a child with its frame. A rendered picture is read only when the path the canvas
   returns is inside the root.
7. **Hard links are the same file.** A hard link is not a link to follow. It is a second name for
   one file, and git treats it that way too. A file hard-linked into the project resolves like any
   other file there; the secrets and gitignore rules still apply to its name.

## 4. Host methods

The shell answers these methods for Kaava's own apps, from the calling surface's cluster, the same
way it answers `context/*`. A plugin is not answered: it is someone else's code, and a reference
reads the project. A plugin's own method of the same name goes to the plugin.

| Method         | Params                      | Result                                       | State |
| -------------- | --------------------------- | -------------------------------------------- | ----- |
| `refs/resolve` | `{ uri }`                   | `Resolved`                                   | PR 1  |
| `refs/search`  | `{ query, kinds?, limit? }` | `{ items: [{ uri, kind, title, detail }] }`  | PR 3  |
| `refs/prompt`  | `{ uris }`                  | `{ blocks: AcpContentBlock[] }`              | PR 3  |

`refs/resolve` resolves as the person: the canvas records `human` as the actor on the calls it
makes. So the agent server's `app_call`, whose caller is an agent, refuses it. It sits before the
write refusal in `apps::call`, so it works on a read-only main.

## 5. The `kaava-context` server

The server is at `/mcp/context`, and `.mcp.json` names it `kaava-context`. It is not `dev_only`, so
it starts on and is listed with developer mode off. Every tool takes an optional `cluster`. Without
one, the call answers from the cluster the person is working in. The server resolves as the agent:
the canvas records `agent` as the actor.

| Tool              | Params                         | Answers                                                        |
| ----------------- | ------------------------------ | -------------------------------------------------------------- |
| `show`            | `{ refs, caption? }`           | The marker below, for one to eight references                  |
| `read`            | `{ uri }`                      | The `Resolved` as content: a header, then each part            |
| `search_context`  | `{ query?, kinds?, limit? }`   | `{ query, hits: [{ uri, kind, title, detail? }] }`, best first |
| `list_comments`   | `{ status?, sources? }`        | `{ comments, total, covers, problems? }`, open ones by default |
| `resolve_comment` | `{ uri, note }`                | `{ uri, status: "resolved", note }`                            |
| `get_selection`   | `{}`                           | `kaava://selection`, read when asked                           |
| `get_canvas_node` | `{ canvas, node }`             | `kaava://canvas/<canvas>#frame=<node>`, read                   |

`read` turns each part into one content block. Text parts become text, and a text part that starts
past line 1 says so. A cut-short excerpt says how to read further. JSON parts are pretty-printed and
images stay images. The header carries the reference, kind, title, `detail`, `withheld` and `meta`.

`search_context` matches names, not file contents. A comment is the exception: it is found by what
it says. Hits are ranked by exact name, then prefix, then a match inside the name, then a match in
the path only. A frame found only by a property ranks last. Files come from a walk that does not
follow links and stops after 20,000 entries. Search never lists a §3 secret, by name or by its
first 64 KB, and never lists a canvas whose file is outside the root. An empty query lists
everything except files and frames. A query is at most 256 characters and 16 words. `limit` is 20
unless given, and at most 50. An empty `kinds` list is refused.

`list_comments` reads from three sources, `viewer`, `canvas` and `design`. It lists at most 100,
and `total` counts all of them. A source that fails to answer adds a line to `problems` and the
others still answer. `resolve_comment` records the agent as the author of the note. It refuses a
comment that is already resolved, so a note the person wrote is never replaced. It refuses a note
over 4,000 characters, and a viewer comment on a read-only main.

`show` changes nothing on disk. It checks each reference against §3, the same way resolving does,
but reads no more than a file's first 64 KB. A secret fails with the rule it matched. A gitignored
file passes, because the tab draws it as withheld. It answers with this marker:

```json
{
  "kaavaShow": {
    "component": "refs",
    "version": 1,
    "props": { "refs": ["kaava://file/scripts/player.gd#L10-L20"], "caption": "The jump" }
  },
  "failed": [{ "uri": "kaava://file/gone.gd", "reason": "there is no `gone.gd` in this project" }]
}
```

A reference that fails its check goes in `failed`, and the rest are still shown. If none pass, the
call fails and gives each reason. A caption is at most 500 characters. The agent host is to lift
`kaavaShow` off the tool result for the tab to draw. That is agent-host work still to land, so for
now the marker reaches the agent and nothing draws it.

**Resources.** `kaava://selection` is published, so a client can subscribe to it. Subscribers are
told when focus moves, at the same moment as for `kaava://workspace/focus`. A selection made inside
a pane without moving focus is not announced, so read it again before acting on it. A server that is
switched off sends no notices and accepts no new subscriptions. Every other reference also reads as
a resource, without being listed. These templates say how to write one:
`kaava://file/{+path}`, `kaava://canvas/{+id}`, `kaava://comment/{id}`,
`kaava://design-comment/{id}` and `kaava://context/{id}`. A resource read answers the same way as
`read`, as text and blob contents in order.

**Sessions.** `mcp::session_servers(app, cluster)` gives the entry for an agent the host launches
for one cluster: `kaava-context`, its URL and a session token (§3.5). It is empty while the
listener is down or the server is switched off, and the agent then runs without it. Its `Debug`
output never shows the token. Nothing launches an agent with it yet: the agent host's
`claude/agent-tab-mcp-servers` branch adds it to the ACP `mcpServers` list.
