# Dragging files onto a terminal

Long-form rationale moved out of the files that implement it. See
[README.md](README.md) for what this page promises: the prose below was copied
here verbatim rather than summarised, and each source file points at its
section.

The feature: drag one or more files onto a terminal and their paths appear at
that terminal's prompt, quoted for the shell it is actually talking to.
**Nothing is executed** — the insertion carries no newline, and that property is
enforced rather than assumed.

Interaction adapted from Orca (`stablyai/orca`, MIT, © Lovecast Inc.); see
[THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md), and the per-file
attribution at each site.

## src/shell/drag/useFileDrag.tsx

### The two drags, and why they are not one

The shell already had a drag layer, `useDrag.tsx`: a pointer gesture watched
from `pointerdown` to `pointerup`, moving tabs and clusters — things the shell
already owns. A file drag is not that, from either direction it can arrive.

**From the operating system.** Explorer starts the drag; the shell first hears
about it when the cursor is already over the window and already carrying paths.
There is no press to threshold and no ghost to draw, because Explorer is drawing
its own. Tauri reports it as `tauri://drag-enter` / `-over` / `-drop` /
`-leave`, wrapped in `bindings.ts` as `onFileDrag`.

**From the Files app.** The tree draws inside an iframe, and an iframe's pointer
events stop at its own edge — the terminal band is in the shell's document,
which the app never hears from, and the shell never hears the app's press. So
the gesture is split down the middle at the frame boundary.

What the two share is the only part worth sharing: where a release lands. Both
ask `dropZones.ts`.

### Why both halves of the frame drag are needed

The shell listens on `window` from the moment the frame says `begin`. That
listener is silent while the cursor is still over the frame and starts reporting
the instant it leaves — and every terminal this drag can aim at is outside the
frame, so nothing that matters is missed.

- **The shell's `pointerup`** is what commits a drop. It fires for a release
  anywhere outside the frame, which is everywhere a drop can land.
- **The frame's `end`** is the release the shell *cannot* see, because letting
  go over the frame sends `pointerup` to the frame. It is the cancel half of the
  gesture, not the drop half.

A release outside the frame reaches the shell's handler before the frame's `end`
could arrive, because a `postMessage` is a task and a `pointerup` handler is
not. So a real drop is always committed before anything can cancel it.

## apps/files/ui/src/explorer/useRowDrag.ts

### Rejected: pointer capture in the frame

`setPointerCapture` inside the iframe would keep routing the pointer to that
document after the cursor left it. That sounds like the tidier answer and is the
wrong one here: it is exactly what would stop the drag ever being seen by the
shell, and therefore ever reaching a terminal. The frame deliberately does not
capture.

### What the frame is not told

The split is one-way on purpose. Files hands over a path it was already showing
and learns nothing back — not the cursor's position outside itself, not which
terminals exist, not whether anything was written. A frame that could ask those
questions would be a frame that could survey the window it is drawn in. Nothing
comes back from `veistra/drag` but an acknowledgement.

## What stayed in the source

Two neighbouring decisions are documented at their own point of use rather than
here, because each is about one specific item rather than about a module's
shape — which is the line [README.md](README.md) draws.

- **Why quoting lives in Rust, what the three dialects are, why an unknown shell
  is treated as POSIX, why quoting is conditional, and why a path holding a
  control character is skipped rather than quoted** —
  `src-tauri/src/quoting.rs`, on the module and on `needs_quoting`.
- **Why every emulator registers its own drop zone, and why that zone is
  deliberately invisible to `hitTest`** — `src/shell/dropZones.ts`, on the
  `terminal` variant and on `terminalAt`.
