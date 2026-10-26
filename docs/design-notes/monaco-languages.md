# Monaco languages design notes

Design rationale moved out of `packages/monaco-languages/src/` to keep comment
concentration under the caps in STANDARDS.md §10. The source files point back here.

## packages/monaco-languages/src/index.ts

Grammars for languages Monaco does not ship, plus the one function that installs them.

There is exactly one language in here today — TOML, which Veistra's own two marker formats
are written in — and the package is named for the general case because the boundary it
exists to cross is general. `src/` and `apps/files/` may not import each other, so
anything both sides of the shell need lives under `packages/`; `@veistra/file-icons` was the
first of these and this is the second. A second grammar would be another file beside
`./toml.ts` and another `register*` below, not a second package.

**Nothing here imports `monaco-editor` at runtime.** The grammars are plain data and the
registrar takes the Monaco namespace as an argument, so this package adds no bytes to a
bundle that has not already paid for Monaco — and, more usefully, it can be imported by a
module that must stay Monaco-free. `worktree/SourceControlView.tsx` is exactly that: it
reaches `DiffView` through a `lazy(() => import(...))` so that opening the source-control
panel does not drag Monaco in, and a static import of anything that touched Monaco would
undo that. `isTomlPath` is safe for it to call because of this rule.

### `MonacoApi`

The `monaco` namespace as `editor.api` exports it.

Written as `typeof import(...)` rather than `import type * as monaco` and `typeof monaco`,
because the latter is not legal: a type-only import binds a name in type space alone, and
`typeof` needs a value to read a type off. The import-type form is erased the same way and
needs no value binding.

`editor.api` deliberately, not `editor.main` — every consumer imports the former (each
header says why), and the three setters used below are on the `languages` namespace that
`editor.api` already exports in full. That is what makes a hand-written Monarch grammar
uniquely portable here: the diff editor has no tokenizer for any *bundled* language
precisely because it never pulled `editor.main` in, and yet it can be handed this one.

### `registerToml`

Teach a Monaco instance TOML. Safe to call more than once.

The guard is not defensive padding — it is the point of routing every editor through one
function. Two of the three consumers (`search/previewMonaco.ts` and `diff/DiffView.tsx`)
are shell-side, so both chunks can be live in one JS context at once, and both would
otherwise register the same id against the same global registry. Monaco tolerates that by
merging the extension lists and letting the last tokens provider win, which is survivable
only for as long as the two registrations stay byte-identical; the theme names in those
same two files had to be pulled apart for the version of this hazard that is not
survivable. Registering once and never again sidesteps the question rather than depending
on the answer.

(Files' editor lives behind an iframe boundary and shares no registry with either, so for
it the guard is simply never true.)

The language's `extensions` are declared on the language itself as well as in each
consumer's extension table. The tables are what the apps resolve through; this declaration
is what Monaco's own machinery reads, and a model created by URI without an explicit
language would otherwise find nothing.

### `isTomlPath`

Whether a path is one this package has a grammar for.

For callers that need to name a language without owning an extension table — the
source-control panel, which knows a file's path and must hand `DiffView` a language id,
but whose whole reason for existing lazily is that it may not import the module where such
a table would live.

Matches the last dot-segment only, and only when there is one after the final path
separator, so a directory with a dot in it does not turn every file under it into TOML.
Same rule as the `extensionOf` helpers on both sides of the boundary, restated here
because neither is reachable from the other.

## packages/monaco-languages/src/toml.ts

### Why it was worth writing rather than aliasing again

`.veistra` is TOML. `src-tauri/src/project/marker.rs` parses a project marker with
`raw.parse::<toml::Table>()`, and `manifest.rs` does the same for `veistra.toml`. So the
three files anyone working in this product opens most — `<project>.veistra`, `veistra.toml`,
`Cargo.toml` — are all one format, and all three were being coloured by a grammar for a
different one.

The `ini` stand-in is not merely imprecise on them, it is wrong on their actual contents:

- Its key rule is `/(^\w+)(\s*)(\=)/`, and `\w` does not include `-`. Every kebab-case key
  Veistra writes — `created-with`, `created-unix-ms`, `checkout-root` — is therefore not
  highlighted as a key at all.
- Its section rule is `/^\[[^\]]*\]/`, which on `veistra.toml`'s `[[tool]]` matches
  `[[tool]` and leaves a stray `]` behind.
- Its comment rule is `/^\s*[#;].*$/`, so a comment after a value on the same line is not
  a comment.
- Arrays, inline tables, multi-line strings and datetimes are all untokenized.

Those five are the exact list the old comment admitted to, so this grammar is measured
against them rather than against TOML in the abstract.

### Why it lives in a package

It was written for the Files app and sat in `apps/files/ui/src/viewer/toml.ts` for exactly
as long as there was one editor to serve. There are now three — Files' viewer, the search
overlay's preview pane, and the source-control diff — and `src/` and `apps/files/` may not
import each other (see the repository CLAUDE.md), so the only ground all three can stand
on is `packages/`. Moving it here is what makes "TOML is highlighted in Veistra" one fact
rather than three copies drifting apart.

That move is also why `index.ts` exports a `registerToml` rather than leaving each editor
to call the three `monaco.languages.*` setters itself. Two of the three consumers are
shell-side and can be live in the same JS context at once, where a second registration of
the same id is a real hazard — the same class of collision the editors' theme names
already had to be pulled apart to avoid.

### Token names are borrowed, not invented

Every token this emits is one `vs-dark` already colours — `key`, `metatag`, `comment`,
`string`, `number`, `number.hex`, `keyword`, `delimiter` (read out of
`editor/standalone/common/themes.js`). That is deliberate and it is what lets every Veistra
theme keep `rules: []`: the theme headers forbid inventing a token colour, on the grounds
that the handoff palette names UI surfaces rather than grammar scopes. Borrowing scopes
the base theme already styles means a `.veistra` file is coloured by exactly the machinery
that colours a `.py` or a `.md`, and this file introduces no palette of its own.

### What it deliberately does not do

No validation, no folding provider, no language service. A Monarch tokenizer is a lexer:
it says what a run of characters *looks* like, not whether the document is well-formed. A
`.veistra` with a duplicate table is coloured perfectly and is still rejected by Rust, which
is the half that gets to have an opinion — the same division every consumer of this
package draws for every other language it registers, except JSON.

### The language id and its exports

Exported rather than spelled as a literal at each call site because three editors and one
caller now name it, and one of those callers (`isTomlPath` in `./index.ts`, used by the
source-control panel) has to agree with the extension list Monaco is given without
importing Monaco to find it out.
