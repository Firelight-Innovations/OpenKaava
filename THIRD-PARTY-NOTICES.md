# Third-party notices

Code from other projects that this repository incorporates **in source form**,
and the licenses it arrives under.

This file is not a dependency list. Crates and npm packages are declared in
`Cargo.toml` and `package.json`, their licenses are checked by
`cargo deny check` (`deny.toml`), and none of them is copied into this tree.
What is listed here is the narrower and rarer case: source that was read,
adapted and committed here, where the obligation travels with the file rather
than with a lockfile entry.

`NOTICE` covers this repository's own license and the trademarks that license
does not grant. This one covers everyone else's.

---

## stablyai/orca — MIT

- **Upstream:** <https://github.com/stablyai/orca>
- **License:** MIT
- **Copyright:** © Stably AI
- **Used in:** Veistra's Design Mode

Orca is an open-source Electron application that runs coding agents in git
worktrees. Its "Design Mode" — click an element in an embedded browser, send
its markup, styles and a cropped screenshot to an agent — is the feature
Veistra's Design Mode is adapted from.

What was carried across is the **approach and the data model**, and in places
the shape of the code: a full-viewport click catcher in a closed shadow root,
`document.elementFromPoint` with the catcher briefly disabled, hashed-class
filtering when building a selector, and a payload with per-field budgets rather
than a whole document. The files that carry adapted code name their source in
their own headers:

| File here | Adapted from |
|---|---|
| `src-tauri/src/apps/design_probe.js` | `src/main/browser/grab-guest-script.ts` |

What was **not** carried across is everything about how Orca embeds and drives
the page. That is Electron's `BrowserView`, `webContents.executeJavaScript` and
`capturePage`, none of which has an equivalent in Tauri; the embedding,
injection and capture here are a Rust rewrite against WebView2 and are original
to this repository. `docs/design-notes/design-mode.md` records why each of those
had to be rebuilt rather than ported.

### The MIT license

```
MIT License

Copyright (c) Stably AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

MIT and Apache-2.0 combine without difficulty in this direction: MIT's
conditions are attribution and the notice above, both satisfied here, and
Apache-2.0 adds obligations rather than removing any.
