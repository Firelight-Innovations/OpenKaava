import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { KaavaRpcError, invoke } from "@openkaava/bridge";
import { AlertCircle, ArrowLeft, Check } from "./icons";
import {
  buildCreateRequest,
  CreateStatus,
  CreateStep,
  deriveSlug,
  derivePlaneId,
  emptyForm,
  formIsValid,
  isServiceWired,
  Kind,
  NewProjectForm,
  STEP_IDS,
  stepPreviewDetail,
  stepTitle,
  validateForm,
} from "./newProject";
import "./newProject.css";

/** How often the page asks `home/create-project-status` while a run is going. */
const POLL_MS = 400;

export interface NewProjectProps {
  /** Back arrow, or a successful finish — either way there is nothing left to
   * do on this page and Home should redraw with whatever changed. */
  onDone: () => void;
}

/**
 * Board 14 — a full page inside Home, not a native dialog. `App.tsx` swaps
 * this in for the whole pane rather than routing to it, since Home has no
 * router: there is exactly one other state (the normal Home screen) and a
 * boolean is enough to choose between them.
 */
export default function NewProject({ onDone }: NewProjectProps) {
  const [form, setForm] = useState<NewProjectForm>(emptyForm);
  // Once a field has been typed into directly, the name field stops
  // overwriting it — the same "touched" idea `WorktreeDialog`'s suggested
  // name uses, just tracked per field instead of once.
  const [slugTouched, setSlugTouched] = useState(false);
  const [planeIdTouched, setPlaneIdTouched] = useState(false);

  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<CreateStatus | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const errors = validateForm(form);
  const valid = formIsValid(errors);
  const finished = status !== null && !status.running;
  const succeeded = finished && status?.openedPath != null;

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(() => {
      void invoke<CreateStatus>("home/create-project-status")
        .then((next) => {
          setStatus(next);
          if (!next.running) stopPolling();
        })
        .catch(() => {
          // The status read failed; the run itself is unaffected. Left
          // silent on any one tick — a poll that fails once and then
          // succeeds again should not have flashed an error the user could
          // do nothing about.
        });
    }, POLL_MS);
  }, [stopPolling]);

  const startCreate = useCallback(() => {
    if (!valid) return;
    setCreating(true);
    setStartError(null);
    setStatus(null);
    void invoke("home/create-project", buildCreateRequest(form))
      .then(() => poll())
      .catch((e: unknown) => {
        setCreating(false);
        setStartError(describe(e));
      });
  }, [valid, form, poll]);

  const setName = (name: string) => {
    setForm((prev) => ({
      ...prev,
      name,
      slug: slugTouched ? prev.slug : deriveSlug(name),
      planeId: planeIdTouched ? prev.planeId : derivePlaneId(name),
    }));
  };

  const setKind = (kind: Kind) => {
    setForm((prev) => ({
      ...prev,
      kind,
      // Open existing only ever links a local folder — see `project::
      // has_manifest` and `apps::home_create::land`, which refuses to write
      // a manifest for this kind rather than treating it as a fresh project.
      codeSource: kind === "openExisting" ? "localFolder" : prev.codeSource,
    }));
  };

  return (
    <div className="new-project">
      <div className="new-project__inner">
        <header className="new-project__header">
          <button
            type="button"
            className="k-btn k-btn--ghost"
            disabled={creating && !finished}
            onClick={onDone}
          >
            <ArrowLeft size={16} />
            <span>Home</span>
          </button>
          <div className="new-project__titles">
            <h1 className="new-project__title">New project</h1>
            <p className="new-project__caption">
              Everything a project needs, in one place — nothing happens until Create.
            </p>
          </div>
        </header>

        <div className="new-project__body">
          <div className="new-project__form">
            <KindSection kind={form.kind} onChange={setKind} disabled={creating} />
            <NameSection
              form={form}
              errors={errors}
              disabled={creating}
              onName={setName}
              onSlug={(slug) => {
                setSlugTouched(true);
                setForm((prev) => ({ ...prev, slug }));
              }}
              onPlaneId={(planeId) => {
                setPlaneIdTouched(true);
                setForm((prev) => ({ ...prev, planeId }));
              }}
            />
            <CodeSection
              form={form}
              errors={errors}
              disabled={creating}
              onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
            />
            {form.kind !== "openExisting" && (
              <ServicesSection
                form={form}
                disabled={creating}
                onChange={(services) => setForm((prev) => ({ ...prev, services }))}
              />
            )}
          </div>

          <aside className="new-project__rail">
            <h2 className="new-project__rail-title">What Create does</h2>
            <ol className="new-project__steps">
              {STEP_IDS.map((id, index) => (
                <StepRow
                  key={id}
                  id={id}
                  kind={form.kind}
                  number={index + 1}
                  live={status?.steps.find((s) => s.id === id) ?? null}
                />
              ))}
            </ol>
            {startError && (
              <p className="new-project__run-error">
                <AlertCircle size={14} /> {startError}
              </p>
            )}
            {finished && !succeeded && (
              <button
                type="button"
                className="k-btn k-btn--secondary k-btn--sm"
                onClick={startCreate}
              >
                Retry
              </button>
            )}
          </aside>
        </div>

        <div className="new-project__footer">
          <button
            type="button"
            className="k-btn k-btn--secondary"
            onClick={onDone}
            disabled={creating && !finished}
          >
            Cancel
          </button>
          {succeeded ? (
            <button type="button" className="k-btn k-btn--primary" onClick={onDone}>
              Done
            </button>
          ) : (
            <button
              type="button"
              className="k-btn k-btn--primary"
              disabled={!valid || (creating && !finished)}
              onClick={startCreate}
            >
              {creating && !finished ? "Creating…" : "Create"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// --- 1 · Kind --------------------------------------------------------------

const KINDS: { value: Kind; name: string; desc: string }[] = [
  { value: "game", name: "Game", desc: "A shipped or shipping title. Gets the artifact registry." },
  { value: "tool", name: "Tool or service", desc: "Internal software with no game build to ship." },
  {
    value: "openExisting",
    name: "Open existing",
    desc: "A repo that already has a project file — this only links it.",
  },
];

function KindSection({
  kind,
  disabled,
  onChange,
}: {
  kind: Kind;
  disabled: boolean;
  onChange: (kind: Kind) => void;
}) {
  return (
    <section className="new-project__section">
      <h2 className="new-project__section-title">1 · What it is</h2>
      <div className="new-project__kinds" role="radiogroup" aria-label="Project kind">
        {KINDS.map((k) => (
          <button
            key={k.value}
            type="button"
            role="radio"
            aria-checked={kind === k.value}
            disabled={disabled}
            className={`new-project__kind${kind === k.value ? " new-project__kind--selected" : ""}`}
            onClick={() => onChange(k.value)}
          >
            <span className="new-project__kind-name">{k.name}</span>
            <span className="new-project__kind-desc">{k.desc}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

// --- 2 · Name ---------------------------------------------------------------

function NameSection({
  form,
  errors,
  disabled,
  onName,
  onSlug,
  onPlaneId,
}: {
  form: NewProjectForm;
  errors: ReturnType<typeof validateForm>;
  disabled: boolean;
  onName: (name: string) => void;
  onSlug: (slug: string) => void;
  onPlaneId: (planeId: string) => void;
}) {
  if (form.kind === "openExisting") return null;

  return (
    <section className="new-project__section">
      <h2 className="new-project__section-title">2 · Name</h2>
      <Field label="Project name" error={errors.name}>
        <input
          className="k-field__input"
          value={form.name}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          placeholder="Torn Apart"
          onChange={(e) => onName(e.target.value)}
        />
      </Field>
      <div className="new-project__field-row">
        <Field label="Slug" hint="Can't change later." error={errors.slug}>
          <input
            className="k-field__input k-field__input--mono"
            value={form.slug}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => onSlug(e.target.value)}
          />
        </Field>
        <Field label="Plane ID" hint="3-5 capitals." error={errors.planeId}>
          <input
            className="k-field__input k-field__input--mono"
            value={form.planeId}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => onPlaneId(e.target.value.toUpperCase())}
          />
        </Field>
      </div>
      <p className="new-project__hint">
        Uniqueness against the bucket, Plane and GitHub isn't checked yet in this build.
      </p>
    </section>
  );
}

// --- 3 · Code ----------------------------------------------------------------

const CODE_SOURCES: { value: NewProjectForm["codeSource"]; label: string }[] = [
  { value: "newGithubRepo", label: "New GitHub repo" },
  { value: "existingRepo", label: "Existing repo" },
  { value: "localFolder", label: "Local folder" },
];

function CodeSection({
  form,
  errors,
  disabled,
  onChange,
}: {
  form: NewProjectForm;
  errors: ReturnType<typeof validateForm>;
  disabled: boolean;
  onChange: (patch: Partial<NewProjectForm>) => void;
}) {
  const browse = useCallback(() => {
    void invoke<{ path: string | null }>("home/browse-folder")
      .then((result) => {
        if (result.path) onChange({ path: result.path });
      })
      .catch(() => {
        // A cancelled or failed picker leaves the field exactly as it was —
        // same convention `home/new-project`'s own picker follows.
      });
  }, [onChange]);

  if (form.kind === "openExisting") {
    return (
      <section className="new-project__section">
        <h2 className="new-project__section-title">3 · Code</h2>
        <Field
          label="Project folder"
          hint="Must already contain a Kaava project file."
          error={errors.path}
        >
          <div className="new-project__input-row">
            <input
              className="k-field__input"
              value={form.path}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onChange({ path: e.target.value })}
            />
            <button
              type="button"
              className="k-btn k-btn--secondary k-btn--sm"
              disabled={disabled}
              onClick={browse}
            >
              Browse…
            </button>
          </div>
        </Field>
      </section>
    );
  }

  return (
    <section className="new-project__section">
      <h2 className="new-project__section-title">3 · Code</h2>
      <div
        className="k-tabs k-tabs--segmented"
        role="tablist"
        aria-label="Where the code comes from"
      >
        {CODE_SOURCES.map((s) => (
          <button
            key={s.value}
            type="button"
            role="tab"
            aria-selected={form.codeSource === s.value}
            disabled={disabled}
            className="k-tab"
            onClick={() => onChange({ codeSource: s.value })}
          >
            {s.label}
          </button>
        ))}
      </div>

      {form.codeSource === "newGithubRepo" && (
        <>
          <Field label="Owner / name" error={errors.ownerRepo}>
            <input
              className="k-field__input k-field__input--mono"
              value={form.ownerRepo}
              disabled={disabled}
              placeholder="Firelight-Innovations/torn-apart"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onChange({ ownerRepo: e.target.value })}
            />
          </Field>
          <p className="new-project__hint">
            Step 1 isn't wired yet — Create will skip it. See the rail.
          </p>
        </>
      )}

      {form.codeSource === "existingRepo" && (
        <>
          <Field label="Repository URL" error={errors.repoUrl}>
            <input
              className="k-field__input k-field__input--mono"
              value={form.repoUrl}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onChange({ repoUrl: e.target.value })}
            />
          </Field>
          <Field label="Clone to" error={errors.path}>
            <div className="new-project__input-row">
              <input
                className="k-field__input"
                value={form.path}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => onChange({ path: e.target.value })}
              />
              <button
                type="button"
                className="k-btn k-btn--secondary k-btn--sm"
                disabled={disabled}
                onClick={browse}
              >
                Browse…
              </button>
            </div>
          </Field>
        </>
      )}

      {form.codeSource === "localFolder" && (
        <Field label="Folder" error={errors.path}>
          <div className="new-project__input-row">
            <input
              className="k-field__input"
              value={form.path}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onChange({ path: e.target.value })}
            />
            <button
              type="button"
              className="k-btn k-btn--secondary k-btn--sm"
              disabled={disabled}
              onClick={browse}
            >
              Browse…
            </button>
          </div>
        </Field>
      )}

      <label className="new-project__checkbox-row">
        <input
          type="checkbox"
          checked={form.protectMain}
          disabled={disabled}
          onChange={(e) => onChange({ protectMain: e.target.checked })}
        />
        Protect main on GitHub
      </label>
    </section>
  );
}

// --- 4 · Project services ----------------------------------------------------

function ServicesSection({
  form,
  disabled,
  onChange,
}: {
  form: NewProjectForm;
  disabled: boolean;
  onChange: (services: NewProjectForm["services"]) => void;
}) {
  const rows: { key: keyof NewProjectForm["services"]; name: string; desc: string }[] = [
    { key: "plane", name: "Plane project", desc: `A Plane project named ${form.planeId || "—"}.` },
    {
      key: "registry",
      name: "Artifact registry prefix",
      desc: "A registry prefix for build artifacts.",
    },
    { key: "hindsight", name: "Hindsight banks", desc: "Memory banks scoped to this project." },
    {
      key: "designWorktree",
      name: "Design canvas worktree",
      desc: "wt/design, alongside the main checkout.",
    },
    {
      key: "costLabel",
      name: "Cost label",
      desc: "Not built yet — resource cost labels are out of scope.",
    },
  ];

  return (
    <section className="new-project__section">
      <h2 className="new-project__section-title">4 · Project services</h2>
      <div className="new-project__services">
        {rows
          .filter((row) => row.key !== "registry" || form.kind === "game")
          .map((row) => {
            const wired = isServiceWired(row.key);
            const rowDisabled = disabled || !wired || row.key === "costLabel";
            return (
              <div
                key={row.key}
                className={`new-project__service${rowDisabled ? " new-project__service--disabled" : ""}`}
              >
                <span className="new-project__service-text">
                  <span className="new-project__service-name">{row.name}</span>
                  <span className="new-project__service-desc">
                    {wired ? row.desc : "Not wired yet in this build."}
                  </span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={form.services[row.key]}
                  disabled={rowDisabled}
                  className="k-toggle"
                  onClick={() => onChange({ ...form.services, [row.key]: !form.services[row.key] })}
                >
                  <span className="k-toggle__knob" />
                </button>
              </div>
            );
          })}
      </div>
    </section>
  );
}

// --- shared bits --------------------------------------------------------------

/**
 * A `.k-field` — see the Field README (`src/kaava-ui.css`'s own header on
 * that class): label, input, one hint line that flips to the error message
 * and `--error`'s colour once there is one to show.
 */
function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <label className={`k-field${error ? " k-field--error" : ""}`}>
      <span className="k-field__label">{label}</span>
      {children}
      {(error ?? hint) && (
        <span className="k-field__hint">
          {error && <AlertCircle size={12} />} {error ?? hint}
        </span>
      )}
    </label>
  );
}

function StepRow({
  id,
  kind,
  number,
  live,
}: {
  id: (typeof STEP_IDS)[number];
  kind: Kind;
  number: number;
  live: CreateStep | null;
}) {
  const status = live?.status ?? "pending";
  // Before a run exists, every row shows the same static preview text
  // `stepPreviewDetail` gives it; once `home/create-project-status` has an
  // opinion, that opinion wins — including a `null` detail for a step still
  // `pending` or `running`, which draws with nothing under the title rather
  // than a preview a live run has already moved past.
  const detail = live ? live.detail : stepPreviewDetail(id);
  const mono = id !== "openProject";

  return (
    <li className={`new-project__step new-project__step--${status}`}>
      <span className="new-project__step-mark">
        {status === "done" ? <Check size={12} /> : number}
      </span>
      <span className="new-project__step-text">
        <span className="new-project__step-title">{stepTitle(id, kind)}</span>
        {detail && (
          <span
            className={`new-project__step-detail${mono ? " new-project__step-detail--mono" : ""}`}
          >
            {detail}
          </span>
        )}
      </span>
    </li>
  );
}

/** Same convention `App.tsx`'s own `describe` follows for an RPC failure. */
function describe(error: unknown): string {
  if (error instanceof KaavaRpcError) return `[${error.code}] ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
