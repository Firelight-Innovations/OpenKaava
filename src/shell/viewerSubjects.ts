/**
 * Which file each File Viewer instance is showing.
 *
 * A File Viewer is one file. The shell therefore needs to know, per instance,
 * which file that is: to focus the tab that already has a path instead of
 * opening it twice, to reuse the one replaceable "preview" tab a single click
 * in the Explorer should take over, and to hand a restored instance its file
 * back after a restart. The instance itself is a frame the shell cannot read, so
 * the viewer reports it (`kaava/title` carries `subject`) and this module keeps
 * the answer.
 *
 * Held in the shell's own `localStorage` rather than in Rust's layout file: the
 * layout persists an instance's id and title, and adding a field there is a
 * migration for a fact only this window reads. An instance whose entry is
 * missing — every viewer saved by a build from before this one — mounts empty
 * and takes the next file it is sent, which is the same as opening a fresh one.
 *
 * Pure functions plus one small store; `planViewerOpen` is where the routing
 * rules are, and it is what the tests exercise.
 */

export interface Subject {
  /** The absolute path the instance is showing. */
  path: string;
  /** This instance is a peek: the next single click takes it over. */
  preview: boolean;
  /** It holds unsaved edits. Closing it would lose them; a peek never is. */
  dirty: boolean;
}

/** What a viewer reports about itself alongside its tab title. */
export interface DeclaredSubject extends Subject {
  title: string;
}

const STORAGE_KEY = "kaava.viewer.subjects.v1";

/**
 * Two spellings of one path must match: a Windows path arrives with either
 * separator, and its drive letter's case is not stable between callers. A path
 * without a drive letter keeps its case, since POSIX file names are case
 * sensitive.
 */
export function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  return /^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed;
}

/** The subject fields off a `kaava/title` request, or `null` when it names none. */
export function declaredSubject(params: unknown): DeclaredSubject | null {
  if (typeof params !== "object" || params === null) return null;
  const { title, subject, preview, dirty } = params as Record<string, unknown>;
  if (typeof title !== "string" || title.trim() === "") return null;
  if (typeof subject !== "string" || subject === "") return null;
  return { title, path: subject, preview: preview === true, dirty: dirty === true };
}

export type OpenPlan =
  { kind: "focus"; id: string } | { kind: "reuse"; id: string } | { kind: "new" };

/**
 * Where a request to show `path` goes, among the viewer instances of one cluster.
 *
 *  1. An instance already showing that file is brought forward.
 *  2. A peek request takes over the cluster's clean peek instance.
 *  3. An instance showing nothing takes it.
 *  4. Otherwise a new instance is opened.
 *
 * `viewerIds` is in layout order, so ties resolve to the first.
 */
export function planViewerOpen(
  viewerIds: readonly string[],
  subjectOf: (id: string) => Subject | undefined,
  path: string,
  preview: boolean,
): OpenPlan {
  const want = normalizePath(path);
  for (const id of viewerIds) {
    const subject = subjectOf(id);
    if (subject && normalizePath(subject.path) === want) return { kind: "focus", id };
  }
  if (preview) {
    for (const id of viewerIds) {
      const subject = subjectOf(id);
      if (subject && subject.preview && !subject.dirty) return { kind: "reuse", id };
    }
  }
  for (const id of viewerIds) {
    if (!subjectOf(id)) return { kind: "reuse", id };
  }
  return { kind: "new" };
}

// --- the store ---------------------------------------------------------------

const subjects = new Map<string, Subject>();
const listeners = new Set<() => void>();
let version = 0;
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return;
    for (const [id, value] of Object.entries(parsed)) {
      const entry = value as Partial<Subject> | null;
      if (entry && typeof entry.path === "string" && entry.path !== "") {
        // A restored instance is a settled tab, never a peek with edits: what
        // was unsaved died with the process.
        subjects.set(id, { path: entry.path, preview: false, dirty: false });
      }
    }
  } catch {
    /* Storage can be blocked or corrupt; every viewer then restores empty. */
  }
}

function save(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(subjects)));
  } catch {
    /* Losing persistence costs a restore, never correctness. */
  }
}

function emit(): void {
  version += 1;
  listeners.forEach((cb) => cb());
}

export function getSubject(id: string): Subject | undefined {
  load();
  return subjects.get(id);
}

/** Set or clear one instance's subject. No-op, and no notification, when unchanged. */
export function setSubject(id: string, next: Subject | null): void {
  load();
  const current = subjects.get(id);
  if (next === null) {
    if (!current) return;
    subjects.delete(id);
  } else {
    if (
      current &&
      current.path === next.path &&
      current.preview === next.preview &&
      current.dirty === next.dirty
    ) {
      return;
    }
    subjects.set(id, next);
  }
  save();
  emit();
}

/** Drop entries for instances that no longer exist, so storage does not grow. */
export function pruneSubjects(liveIds: ReadonlySet<string>): void {
  load();
  let changed = false;
  for (const id of [...subjects.keys()]) {
    if (!liveIds.has(id)) {
      subjects.delete(id);
      changed = true;
    }
  }
  if (changed) {
    save();
    emit();
  }
}

export function subscribeSubjects(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** A stable snapshot for `useSyncExternalStore`: changes exactly when a subject does. */
export function subjectsVersion(): number {
  return version;
}

/** Test seam: forget everything, including what was loaded from storage. */
export function resetSubjectsForTest(): void {
  subjects.clear();
  loaded = false;
  version = 0;
}
