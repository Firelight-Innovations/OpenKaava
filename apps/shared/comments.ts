/**
 * The comment model shared by the Godot Viewer, the Blender Viewer and Play —
 * three apps, one store. `docs/KAAVA-UX-REWORK.md` §3.4: a comment anchors to
 * a node path, a mesh part plus material, or a scene plus a playhead time plus
 * a screenshot, and lives as a file in `.kaava/comments/` inside the calling
 * cluster's environment.
 *
 * The three apps' Rust halves (`godot_viewer.rs`, `blender_viewer.rs`,
 * `play.rs`) all answer the same three methods below by delegating to
 * `src-tauri/src/comments.rs`, so this module — like `viewer/ui/src/rpc.ts` for
 * the Files app — *restates* the wire shapes rather than importing anything
 * from `src/`. It is the one place any of the three apps spells
 * `"comments/create"`.
 *
 * This lives under `apps/shared/` rather than in one of the three apps,
 * because ESLint's app-isolation rule (`eslint.config.js`) forbids an app
 * importing another app's source — three copies of this file would drift the
 * moment one of them fixed a bug the other two still had. `apps/shared/` is
 * deliberately outside that rule (see `apps/README.md`'s layout note).
 */
import { invoke } from "@openkaava/bridge";

// --- what the backend returns --------------------------------------------

/** Where a comment points — exactly the three anchors the written spec names. */
export type Anchor =
  | { kind: "node"; path: string }
  | { kind: "mesh"; part: string; material: string }
  | { kind: "scene"; scene: string; time: number; screenshot: boolean };

/** As {@link Anchor}, minus the one field a caller never gets to assert:
 *  whether a screenshot exists is decided by whether {@link CreateCommentInput.screenshotBase64}
 *  actually wrote one, not by what a draft claims. */
export type AnchorInput =
  | { kind: "node"; path: string }
  | { kind: "mesh"; part: string; material: string }
  | { kind: "scene"; scene: string; time: number };

export type Author = "user" | "agent";

export type Status = "open" | "resolved";

export interface Resolution {
  note: string;
  by: Author;
  /** Milliseconds since the Unix epoch. */
  at: number;
}

export interface Comment {
  id: string;
  anchor: Anchor;
  author: Author;
  body: string;
  status: Status;
  /** Absent, not `null` — the Rust side skips the field entirely on an open
   *  comment (`#[serde(skip_serializing_if = "Option::is_none")]`), so an open
   *  comment's JSON simply has no `resolution` key. */
  resolution?: Resolution;
  created: number;
  updated: number;
}

// --- the calls --------------------------------------------------------------

export interface CreateCommentInput {
  anchor: AnchorInput;
  body: string;
  /** Standard base64, no data-URI prefix — see `viewer/ui/src/rpc.ts`'s
   *  `toBytes` for the decoding half of this convention. Only meaningful when
   *  `anchor.kind === "scene"`; the backend ignores it otherwise. */
  screenshotBase64?: string;
}

/** Every comment in this cluster's environment, oldest first. */
export const listComments = () => invoke<Comment[]>("comments/list");

/** Write a new comment down and get back what was stored, id included. */
export const createComment = (input: CreateCommentInput) =>
  invoke<Comment>("comments/create", input);

/** Close a comment with a note — "Resolve with a note" in every comment panel. */
export const resolveComment = (id: string, note: string) =>
  invoke<Comment>("comments/resolve", { id, note });

// --- display --------------------------------------------------------------

/**
 * The one-line description a comment card or pin shows beside its badge —
 * board 05's "Play · 00:42.8 · hospital_wing" / "Scene · Player/Flashlight"
 * shape, generalised: what kind of thing this is, then the detail that tells
 * two comments of the same kind apart.
 */
export function anchorLabel(anchor: Anchor): string {
  switch (anchor.kind) {
    case "node":
      return `Node · ${anchor.path}`;
    case "mesh":
      return `${anchor.part} · ${anchor.material}`;
    case "scene":
      return anchor.scene
        ? `Play · ${formatPlayTime(anchor.time)} · ${anchor.scene}`
        : `Play · ${formatPlayTime(anchor.time)}`;
  }
}

/**
 * Seconds as Play's footer and comment cards show a playhead: `mm:ss.s`, one
 * decimal place — `42.8` becomes `"00:42.8"`, matching board 05's `t=00:42.8`.
 * Negative input is clamped to zero; a playhead never runs backwards, and a
 * caller passing a bad value deserves `00:00.0` rather than a minus sign no
 * one asked to render.
 */
export function formatPlayTime(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}
