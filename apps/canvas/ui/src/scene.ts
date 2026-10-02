/**
 * The canvas file's shape and the pure functions around it. Nothing here
 * imports Excalidraw: the editor hands over plain elements, and this decides
 * what of them is written to the game repository and when a change is real.
 *
 * The file is an Excalidraw scene plus one `kaava` object (`docs/cloud-services.md`
 * §4). Rust owns the bookkeeping fields (`schema`, `id`, `updated`,
 * `updated_by`); the title and the parent link are this side's.
 */

export interface KaavaMeta {
  schema?: number;
  id?: string;
  title?: string;
  /** The id of the canvas this one was opened from. */
  parent?: string;
  updated?: string;
  updated_by?: string;
}

export interface SceneElement {
  id: string;
  type: string;
  version?: number;
  versionNonce?: number;
  isDeleted?: boolean;
  fileId?: string | null;
  [key: string]: unknown;
}

export interface SceneFile {
  type: "excalidraw";
  version: number;
  elements: SceneElement[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
  kaava?: KaavaMeta;
}

/** The only view settings worth committing: everything else in Excalidraw's
 *  app state (scroll, zoom, selection, the active tool) changes on every
 *  gesture and would make each save a noisy diff. */
const KEPT_APP_STATE = ["viewBackgroundColor", "gridSize"] as const;

/** Whether `el` is the picture the editor draws into a sub-canvas frame. */
export function isSnapshot(el: { [key: string]: unknown }): boolean {
  const kaava = (el.customData as { kaava?: { snapshot?: unknown } } | undefined)?.kaava;
  return kaava?.snapshot === true;
}

/**
 * What to write for the editor's current state.
 *
 * Deleted elements are dropped: Excalidraw keeps tombstones for collaboration,
 * which a file in git does not need and which would grow every canvas forever.
 * Files (pasted images) are kept only while an element still points at them.
 */
export function toSaved(
  elements: readonly SceneElement[],
  appState: Record<string, unknown>,
  files: Record<string, unknown>,
  kaava: KaavaMeta | undefined,
): SceneFile {
  // A sub-canvas frame's picture is redrawn from its child on every open, so
  // it is never written into the parent (`subcanvas.ts`).
  const live = elements.filter((e) => !e.isDeleted && !isSnapshot(e));
  const referenced = new Set(live.map((e) => e.fileId).filter((f): f is string => !!f));
  const keptFiles: Record<string, unknown> = {};
  for (const id of Object.keys(files)) if (referenced.has(id)) keptFiles[id] = files[id];
  const keptState: Record<string, unknown> = {};
  for (const key of KEPT_APP_STATE) if (key in appState) keptState[key] = appState[key];
  return {
    type: "excalidraw",
    version: 2,
    elements: live,
    appState: keptState,
    files: keptFiles,
    ...(kaava ? { kaava } : {}),
  };
}

/**
 * A cheap fingerprint of what would be saved. Excalidraw calls `onChange` for
 * scrolling and selection too; comparing signatures is what keeps those from
 * writing the file. An element's `version` rises on every edit to it, so
 * `id:version` per live element (plus the view settings and file ids) changes
 * exactly when the saved content would.
 */
export function signature(scene: SceneFile): string {
  const parts = scene.elements.map((e) => `${e.id}:${e.version ?? 0}:${e.versionNonce ?? 0}`);
  parts.push(`files=${Object.keys(scene.files).sort().join(",")}`);
  parts.push(`bg=${String(scene.appState.viewBackgroundColor ?? "")}`);
  parts.push(`grid=${String(scene.appState.gridSize ?? "")}`);
  parts.push(`title=${scene.kaava?.title ?? ""}`);
  return parts.join("|");
}

/** A canvas id (`levels/ward-b`) from a display name. Mirrors the slug rule in
 *  `apps/canvas.rs`; the backend re-checks it, this only proposes one. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

/** `base`, or `base-2`, `base-3`... — the first id not in `taken`. */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const root = base || "canvas";
  if (!taken.has(root)) return root;
  for (let n = 2; ; n += 1) {
    const candidate = `${root}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
