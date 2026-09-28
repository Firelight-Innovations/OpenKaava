/**
 * The New Project page's model — everything that is pure enough to test
 * without a DOM or a round trip: deriving the slug and Plane ID from the
 * project name, validating every field, and shaping a `home/create-project`
 * request and reading back its `home/create-project-status` reply.
 *
 * Kept apart from `NewProject.tsx` for the same reason `WorktreeDialog.tsx`
 * keeps its own `validate` free of JSX — a bug in "what counts as a valid
 * slug" should be catchable without rendering anything.
 */

// --- what the page is filling in --------------------------------------------

/** §7 "1 · WHAT IT IS". */
export type Kind = "game" | "tool" | "openExisting";

/** §7 "3 · CODE" — the segmented control's three options. */
export type CodeSource = "newGithubRepo" | "existingRepo" | "localFolder";

/**
 * Everything the page holds, before it is turned into a `home/create-project`
 * request. One flat object rather than a union keyed on `codeSource`, because
 * the fields for a source the user is not on are not discarded — switching
 * the segmented control and back must not lose what was typed into the other
 * two.
 */
export interface NewProjectForm {
  kind: Kind;
  name: string;
  slug: string;
  planeId: string;
  codeSource: CodeSource;
  /** "owner/name" — `newGithubRepo` only. */
  ownerRepo: string;
  /** `newGithubRepo` only; a label from a fixed list, not validated here. */
  template: string;
  /** The URL to clone — `existingRepo` only. */
  repoUrl: string;
  /** Where the code ends up: the clone destination for `newGithubRepo` and
   * `existingRepo`, and the folder itself for `localFolder`. */
  path: string;
  protectMain: boolean;
  services: {
    plane: boolean;
    /** Games only — the page hides this row entirely for every other kind,
     * per §7 "Artifact registry prefix … (games only)". */
    registry: boolean;
    hindsight: boolean;
    designWorktree: boolean;
    /** Off and disabled everywhere: UI-7 has not shipped resource labels yet,
     * so there is nothing for this toggle to turn on. */
    costLabel: boolean;
  };
}

export function emptyForm(): NewProjectForm {
  return {
    kind: "game",
    name: "",
    slug: "",
    planeId: "",
    codeSource: "newGithubRepo",
    ownerRepo: "",
    template: "",
    repoUrl: "",
    path: "",
    protectMain: true,
    services: {
      // Only `designWorktree` corresponds to a step this build actually runs
      // (`StepId::DesignWorktree` in `project::create`) — Plane, the
      // registry and Hindsight are all `notWired` today, and a toggle for a
      // step that cannot run defaults off rather than promising something
      // Create cannot honour. See [`isServiceWired`].
      plane: false,
      registry: false,
      hindsight: false,
      designWorktree: true,
      costLabel: false,
    },
  };
}

/**
 * Whether flipping this service's toggle has any effect on what
 * `home/create-project` actually does. `apps::home_create::run_create` never
 * reads `services` from the request at all yet — `buildCreateRequest` sends
 * only `kind` and `code` — so every toggle but `designWorktree` is disabled
 * in the UI rather than left clickable with no backend behind the click.
 */
export function isServiceWired(service: keyof NewProjectForm["services"]): boolean {
  return service === "designWorktree";
}

// --- derivation --------------------------------------------------------------

/**
 * The slug: lowercase, `[a-z0-9-]` only, runs of anything else collapsed to
 * one dash, no leading or trailing dash, capped at 40 characters — the same
 * shape [`validateSlug`] checks, so a name that derives cleanly never then
 * fails its own field's validation.
 */
export function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * The Plane ID: the name's first word, uppercased and capped at 5 letters —
 * "Torn Apart" → "TORN", matching board 14's own example. A first word under
 * 3 letters borrows from the next word until it clears the floor, and a name
 * with no letters at all falls back to `"XXX"` rather than deriving an empty
 * id nothing downstream expects.
 */
export function derivePlaneId(name: string): string {
  const words = name
    .split(/[^A-Za-z]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toUpperCase());

  let id = "";
  for (const word of words) {
    if (id.length >= 3) break;
    id = (id + word).slice(0, 5);
  }
  return id.length >= 3 ? id : id.padEnd(3, "X");
}

// --- synchronous validation ---------------------------------------------------

/** `null` means valid. Every validator returns the message to show under the
 * field, in the field's own words, the same convention `WorktreeDialog.tsx`'s
 * `validate` uses. */
export type FieldError = string | null;

export function validateName(name: string): FieldError {
  return name.trim().length === 0 ? "Name is required." : null;
}

const SLUG_PATTERN = /^[a-z0-9-]{2,40}$/;

export function validateSlug(slug: string): FieldError {
  if (slug.length === 0) return "Slug is required.";
  if (!SLUG_PATTERN.test(slug)) {
    return "Lowercase letters, digits and dashes, 2–40 characters.";
  }
  return null;
}

const PLANE_ID_PATTERN = /^[A-Z]{3,5}$/;

export function validatePlaneId(id: string): FieldError {
  if (id.length === 0) return "Plane ID is required.";
  if (!PLANE_ID_PATTERN.test(id)) return "3–5 capital letters.";
  return null;
}

export function validateOwnerRepo(ownerRepo: string): FieldError {
  if (!/^[^/\s]+\/[^/\s]+$/.test(ownerRepo)) return "Format: owner/name.";
  return null;
}

export function validateRepoUrl(url: string): FieldError {
  if (url.trim().length === 0) return "A repository URL is required.";
  return null;
}

export function validatePath(path: string): FieldError {
  return path.trim().length === 0 ? "A folder is required." : null;
}

/** Every field this form can show an inline error under, keyed the way
 * `NewProject.tsx` reads it back. `null` for a field with nothing to say. */
export interface FormErrors {
  name: FieldError;
  slug: FieldError;
  planeId: FieldError;
  ownerRepo: FieldError;
  repoUrl: FieldError;
  path: FieldError;
}

/**
 * Every field's own error, all at once — what disables the Create button.
 * Only the fields the current `codeSource` actually shows are checked; the
 * other two code sections' fields are never validated while they are hidden,
 * matching [`buildCreateRequest`]'s own narrowing.
 */
export function validateForm(form: NewProjectForm): FormErrors {
  return {
    name: validateName(form.name),
    slug: validateSlug(form.slug),
    planeId: validatePlaneId(form.planeId),
    ownerRepo: form.codeSource === "newGithubRepo" ? validateOwnerRepo(form.ownerRepo) : null,
    repoUrl: form.codeSource === "existingRepo" ? validateRepoUrl(form.repoUrl) : null,
    path: form.codeSource !== "newGithubRepo" ? validatePath(form.path) : null,
  };
}

export function formIsValid(errors: FormErrors): boolean {
  return Object.values(errors).every((error) => error === null);
}

// --- async validation (the bucket, Plane and GitHub) --------------------------

export type CheckStatus = "ok" | "conflict" | "unknown" | "error";

export interface CheckResult {
  status: CheckStatus;
  message: string;
}

/**
 * The three uniqueness checks §7's "Validation" paragraph asks for — the
 * bucket, Plane and GitHub — behind one typed interface, so a real
 * implementation can replace [`unwiredValidators`] without `NewProject.tsx`
 * changing at all.
 */
export interface AsyncValidators {
  slugAvailable(slug: string): Promise<CheckResult>;
  planeIdAvailable(planeId: string): Promise<CheckResult>;
  repoNameAvailable(ownerRepo: string): Promise<CheckResult>;
}

const NOT_CHECKED: CheckResult = {
  status: "unknown",
  message: "Not checked yet — this build cannot reach it.",
};

/**
 * The only honest implementation this build can ship. `home/create-project`
 * never calls GCS, Plane or GitHub (see the UX rework brief), so pretending
 * to check any of the three here would be reporting a result nothing behind
 * it actually produced. Every call reports [`NOT_CHECKED`] rather than `ok`
 * — a silent false "available" is worse than an honest "not checked yet".
 */
export const unwiredValidators: AsyncValidators = {
  slugAvailable: () => Promise.resolve(NOT_CHECKED),
  planeIdAvailable: () => Promise.resolve(NOT_CHECKED),
  repoNameAvailable: () => Promise.resolve(NOT_CHECKED),
};

// --- talking to `home/create-project` -----------------------------------------

/** `home/create-project`'s params, matching `apps::home_create::parse_request`. */
export type CreateRequestCode =
  | { source: "newGithubRepo" }
  | { source: "existingRepo"; url: string; cloneTo: string }
  | { source: "localFolder"; path: string };

export interface CreateRequest {
  kind: Kind;
  code: CreateRequestCode;
}

export function buildCreateRequest(form: NewProjectForm): CreateRequest {
  switch (form.codeSource) {
    case "newGithubRepo":
      return { kind: form.kind, code: { source: "newGithubRepo" } };
    case "existingRepo":
      return {
        kind: form.kind,
        code: { source: "existingRepo", url: form.repoUrl, cloneTo: form.path },
      };
    case "localFolder":
      return { kind: form.kind, code: { source: "localFolder", path: form.path } };
  }
}

/** One of the eight fixed steps §7 lists, as `apps::home_create::to_wire` shapes it. */
export type StepStatusTag = "pending" | "running" | "done" | "skipped" | "failed" | "rolledBack";

export interface CreateStep {
  id: string;
  number: number;
  status: StepStatusTag;
  detail: string | null;
}

/** `home/create-project-status`'s reply. */
export interface CreateStatus {
  steps: CreateStep[];
  running: boolean;
  openedPath: string | null;
  failedStep: string | null;
}

// --- the Create rail's fixed step list -----------------------------------------

/**
 * The eight steps, in §7's order and matching `create::STEP_ORDER`'s wire ids
 * one to one (`apps::home_create::step_id_str`) — checked against a live
 * status reply by [`stepTitle`] never being asked for an id it does not know.
 */
export const STEP_IDS = [
  "githubRepo",
  "cloneOrLink",
  "plane",
  "registry",
  "hindsight",
  "projectRecord",
  "designWorktree",
  "openProject",
] as const;

/**
 * Whether this build actually does the step, rather than reporting it
 * `skipped` with a "not wired yet" detail every time. Drives both the rail's
 * greyed-out rows before Create is pressed and [`isServiceWired`] above.
 */
export function isStepWired(id: (typeof STEP_IDS)[number]): boolean {
  return id === "cloneOrLink" || id === "designWorktree" || id === "openProject";
}

/**
 * What each step's title says, before any run has told it otherwise. The
 * board's own copy says "Clone it and write kaava.toml" for step 2; this
 * build's manifest is actually `<name>.kaava` (see `project::marker`'s own
 * doc comment for why), so the title below corrects that rather than
 * repeating a filename this build would never write.
 */
export function stepTitle(id: (typeof STEP_IDS)[number], kind: Kind): string {
  switch (id) {
    case "githubRepo":
      return "Create the GitHub repository";
    case "cloneOrLink":
      return kind === "openExisting" ? "Link the existing folder" : "Clone or create the folder";
    case "plane":
      return "Create the Plane project";
    case "registry":
      return "Reserve the artifact registry prefix";
    case "hindsight":
      return "Create the Hindsight banks";
    case "projectRecord":
      return "Write the project record";
    case "designWorktree":
      return "Create the wt/design worktree";
    case "openProject":
      return "Open the project";
  }
}

/**
 * The static, before-Create preview of what a step will do — shown until
 * `home/create-project-status` has something live to say instead. Not the
 * same text a finished run reports (that comes from the backend's own
 * `detail`), just enough to set expectations, honest about the five steps
 * this build always skips.
 */
export function stepPreviewDetail(id: (typeof STEP_IDS)[number]): string {
  if (!isStepWired(id)) return "Not wired yet in this build.";
  switch (id) {
    case "cloneOrLink":
      return "Lands the code on disk and writes the <name>.kaava manifest if it isn't there yet.";
    case "designWorktree":
      return "wt/design, for design-canvas work that shouldn't collide with the main checkout.";
    case "openProject":
      return "Opens the project into this cluster and adds it to Recent.";
    default:
      return "";
  }
}
