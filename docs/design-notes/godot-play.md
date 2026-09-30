# Godot: Play, the Godot Viewer, and Open in Godot

Code: `src-tauri/src/godot/` (`detect`, `runner`, `addon`, `scene`, `rpc`), routed from
`apps/play.rs` and `apps/godot_viewer.rs`. Frontends: `apps/play/ui`, `apps/godot-viewer/ui`,
shared types in `apps/shared/godot.ts`.

The rule everything obeys is `KAAVA-UX-REWORK.md` section 3.1: Godot is never embedded in the
webview. It is a native process Kaava starts, watches and stops.

## Section 9.2, decided: a native run

Play runs `godot --path <project>` as a child process of the environment. The game opens in its
own window and the pane shows what Kaava can honestly know about it: state, an stdout/stderr
log with errors and warnings highlighted, and pause, restart and stop.

The alternative was a web export shown in the pane. It was rejected because it needs an export
template and a build step before the first frame, changes what the game is (WebGL, no threads,
no native extensions), and would make "Play" mean a different program from the one that ships.
A native run needs nothing but the engine, and what it shows is what the player gets.

Cost: the frame is not in the pane. That is what Capture is for.

## Finding the engine

`detect.rs`. An explicit `godot.executablePath` setting is authoritative: a bad value is
reported, never silently replaced by another install. With no setting, the order is the
`GODOT4`/`GODOT` variables, `PATH`, common install folders, then Steam libraries. The first
that answers `--version` with a 4.x wins. On Windows the `_console.exe` sibling is preferred
for runs, because the GUI-subsystem exe writes nothing to a pipe. A found engine is remembered
until the setting changes or the pane asks to check again; a failed search is never cached.

Projects are `project.godot` files at or below the environment root (four folders deep,
skipping `.git`, `.godot`, `node_modules`, `.kaava`, `addons`). With several, the pane offers a
picker. A `config_version` of 4 or less is Godot 3 and is refused with a message.

## The run

`runner.rs`. One run per cluster. stdout and stderr are read on their own threads into a
bounded log (4000 lines, oldest dropped, drops counted). Lines are classified from the prefixes
Godot prints (`ERROR:`, `SCRIPT ERROR:`, `WARNING:`), and indented `at:` lines inherit the level
of the line they follow. The pane polls `play/state` with a cursor every 500 ms.

Stop kills the whole tree: `taskkill /T /F` on Windows, the process group on Unix, so the game
window and anything it spawned go with it. `RunEvent::Exit` calls `Godot::shutdown`, so no game
outlives Kaava. `Stopped` (asked for) and `Exited { code }` (the game ended) are different
states.

## Capture & comment, and pause

Godot has no external "give me a frame" interface, so a real screenshot needs code inside the
game. That is the capture addon: one GDScript autoload, opt in per project, consent-gated,
removable.

- Enable adds `addons/kaava/kaava_capture.gd` and one `[autoload]` line to `project.godot`.
  Disable removes exactly those, leaving anything else in `addons/kaava/` alone.
- The channel is a folder in the OS temp directory, passed as `-- --kaava-dir=<dir>`. Kaava
  writes `cmd.json` (atomically), the script answers `res-<id>.json`. No socket, no listener,
  no network. A reply may not name a file outside its own folder.
- Without the addon, Capture and Pause are disabled and say why. Nothing is faked.

## The Godot Viewer

`scene.rs`. Refresh runs `godot --headless --path P -s dump_scene.gd -- --out F --scene S`,
which instantiates the scene without adding it to the tree and writes its nodes as JSON.
`--import` runs first when the project has no `.godot/` cache. The result is cached, stamped,
and shown with its age; nothing runs until someone presses Refresh.

If Godot is missing or the run fails, the tree is parsed from the `.tscn` text instead and the
pane says so ("Read from the scene file - Godot did not run", with the reason). Instanced
scenes take their type from the scene they instance, to a depth of four.

Render view is a separate, explicit action: Godot's Movie Maker mode for one frame, keeping the
last frame written. It is not headless, since a headless run has no renderer, so a Godot window
appears briefly. The frame is cached beside the tree and stamped separately.

## Read-only main (#163)

Running and viewing read the project, so they work on main. Writing does not:
`godot/open-editor`, `play/addon-install` and `play/addon-remove` are in `WRITE_METHODS` and are
refused on main before a handler runs. The viewer's cache goes under the app-local data folder
for main and under `<env>/.kaava/godot-viewer/` for a worktree; run channels are always in temp.

What Kaava cannot prevent: Godot writes `<project>/.godot/` (import cache) whenever it loads a
project. It is engine-generated and gitignored by every Godot template.
