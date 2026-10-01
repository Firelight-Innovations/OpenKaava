import { useState } from "react";
import { ArrowLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { FIELD_KINDS, ICON_NAMES, type FieldDef, type FieldKind, type TypeDef } from "./objects";
import TypeIcon from "./TypeIcon";

interface Props {
  types: TypeDef[];
  readOnly: boolean;
  /** Save a custom type; resolves to an error message, or `null` when saved. */
  onSave: (def: Omit<TypeDef, "builtin">) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
  onClose: () => void;
}

interface DraftField {
  key: string;
  /** An existing field's key is fixed: frames store their values under it. */
  locked: boolean;
  label: string;
  kind: FieldKind;
  options: string;
  initial: string;
  flag: boolean;
}

interface Draft {
  id: string;
  isNew: boolean;
  name: string;
  color: string;
  icon: string;
  description: string;
  fields: DraftField[];
}

const slug = (text: string, joiner: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, joiner)
    .replace(new RegExp(`^${joiner}+|${joiner}+$`, "g"), "")
    .replace(/^[0-9]+/, "");

function toDraft(def: TypeDef | null): Draft {
  if (!def) {
    return {
      id: "",
      isNew: true,
      name: "",
      color: "#6366f1",
      icon: "shapes",
      description: "",
      fields: [],
    };
  }
  return {
    id: def.id,
    isNew: false,
    name: def.name,
    color: def.color,
    icon: def.icon,
    description: def.description ?? "",
    fields: def.fields.map((f) => ({
      key: f.key,
      locked: true,
      label: f.label,
      kind: f.kind,
      options: (f.options ?? []).join(", "),
      initial:
        f.kind === "path-list"
          ? Array.isArray(f.default)
            ? f.default.join("\n")
            : ""
          : f.default === undefined || f.default === null || f.kind === "bool"
            ? ""
            : String(f.default),
      flag: f.default === true,
    })),
  };
}

function fieldOf(f: DraftField): FieldDef {
  const out: FieldDef = { key: f.key, label: f.label.trim(), kind: f.kind };
  const opts = f.options
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (f.kind === "enum") out.options = opts;
  if (f.kind === "bool") out.default = f.flag;
  else if (f.kind === "number" && f.initial.trim() !== "" && Number.isFinite(Number(f.initial))) {
    out.default = Number(f.initial);
  } else if (f.kind === "enum" && opts.includes(f.initial.trim())) out.default = f.initial.trim();
  else if ((f.kind === "text" || f.kind === "multiline") && f.initial !== "")
    out.default = f.initial;
  else if (f.kind === "path-list" && f.initial.trim() !== "") {
    out.default = f.initial
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }
  return out;
}

/**
 * The "Manage types" view of the Inspector: the built-in types (fixed) and the
 * project's own, which can be made, edited and deleted. Custom types are saved
 * per project by the backend, which validates them again.
 */
export default function TypesPanel({ types, readOnly, onSave, onDelete, onClose }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const custom = types.filter((t) => !t.builtin);
  const builtin = types.filter((t) => t.builtin);

  const patch = (next: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...next } : d));
  const patchField = (i: number, next: Partial<DraftField>) =>
    setDraft((d) =>
      d ? { ...d, fields: d.fields.map((f, n) => (n === i ? { ...f, ...next } : f)) } : d,
    );

  const save = async () => {
    if (!draft) return;
    const id = draft.isNew ? slug(draft.name, "-").slice(0, 40) : draft.id;
    if (!draft.name.trim()) return setError("Give the type a name.");
    if (!id) return setError("The name needs at least one letter.");
    const fields = draft.fields.map((f) => ({
      ...f,
      key: f.locked ? f.key : slug(f.key || f.label, "_").slice(0, 48),
    }));
    if (fields.some((f) => !f.label.trim() || !f.key)) {
      return setError("Every field needs a label.");
    }
    setError(null);
    const message = await onSave({
      id,
      name: draft.name.trim(),
      color: draft.color,
      icon: draft.icon,
      description: draft.description.trim(),
      fields: fields.map(fieldOf),
    });
    if (message) setError(message);
    else setDraft(null);
  };

  const remove = async (id: string) => {
    const message = await onDelete(id);
    setError(message);
  };

  if (draft) {
    return (
      <section className="cv__types cv__side-section" aria-label="Edit type">
        <div className="cv__spec-head">
          <strong>{draft.isNew ? "New type" : `Edit ${draft.name}`}</strong>
        </div>
        <div className="cv__field">
          <label htmlFor="type-name">Type name</label>
          <input
            id="type-name"
            className="cv__input"
            value={draft.name}
            placeholder="Vehicle"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </div>
        <div className="cv__row">
          <div className="cv__field">
            <label htmlFor="type-color">Colour</label>
            <input
              id="type-color"
              type="color"
              value={draft.color}
              onChange={(e) => patch({ color: e.target.value })}
            />
          </div>
          <div className="cv__field">
            <label htmlFor="type-icon">Icon</label>
            <select
              id="type-icon"
              className="cv__select"
              value={draft.icon}
              onChange={(e) => patch({ icon: e.target.value })}
            >
              {ICON_NAMES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="cv__field">
          <label htmlFor="type-about">Description</label>
          <input
            id="type-about"
            className="cv__input"
            value={draft.description}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </div>
        <h3>Fields</h3>
        {draft.fields.map((f, i) => (
          <fieldset key={i} className="cv__fieldset">
            <legend>{f.label || `Field ${i + 1}`}</legend>
            <div className="cv__field">
              <label htmlFor={`f-label-${i}`}>Label</label>
              <input
                id={`f-label-${i}`}
                className="cv__input"
                value={f.label}
                onChange={(e) => patchField(i, { label: e.target.value })}
              />
            </div>
            <div className="cv__field">
              <label htmlFor={`f-kind-${i}`}>Kind</label>
              <select
                id={`f-kind-${i}`}
                className="cv__select"
                value={f.kind}
                onChange={(e) => patchField(i, { kind: e.target.value as FieldKind })}
              >
                {FIELD_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            {f.kind === "enum" && (
              <div className="cv__field">
                <label htmlFor={`f-opts-${i}`}>Options (comma separated)</label>
                <input
                  id={`f-opts-${i}`}
                  className="cv__input"
                  value={f.options}
                  onChange={(e) => patchField(i, { options: e.target.value })}
                />
              </div>
            )}
            {f.kind === "bool" ? (
              <div className="cv__field cv__field--check">
                <input
                  id={`f-def-${i}`}
                  type="checkbox"
                  checked={f.flag}
                  onChange={(e) => patchField(i, { flag: e.target.checked })}
                />
                <label htmlFor={`f-def-${i}`}>On by default</label>
              </div>
            ) : (
              <div className="cv__field">
                <label htmlFor={`f-def-${i}`}>Default</label>
                <input
                  id={`f-def-${i}`}
                  className="cv__input"
                  value={f.initial}
                  onChange={(e) => patchField(i, { initial: e.target.value })}
                />
              </div>
            )}
            <button
              type="button"
              className="k-btn k-btn--ghost k-btn--sm"
              onClick={() =>
                setDraft((d) => (d ? { ...d, fields: d.fields.filter((_, n) => n !== i) } : d))
              }
            >
              <Trash2 size={14} aria-hidden /> Remove field
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className="k-btn k-btn--secondary k-btn--sm"
          onClick={() =>
            setDraft((d) =>
              d
                ? {
                    ...d,
                    fields: [
                      ...d.fields,
                      {
                        key: "",
                        locked: false,
                        label: "",
                        kind: "text",
                        options: "",
                        initial: "",
                        flag: false,
                      },
                    ],
                  }
                : d,
            )
          }
        >
          <Plus size={14} aria-hidden /> Add field
        </button>
        {error && (
          <small className="cv__field-error" role="alert">
            {error}
          </small>
        )}
        <div className="cv__spec-actions">
          <button
            type="button"
            className="k-btn k-btn--primary k-btn--sm"
            onClick={() => void save()}
          >
            Save type
          </button>
          <button
            type="button"
            className="k-btn k-btn--ghost k-btn--sm"
            onClick={() => {
              setDraft(null);
              setError(null);
            }}
          >
            Cancel
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="cv__types cv__side-section" aria-label="Object types">
      <div className="cv__spec-head">
        <button type="button" className="k-btn k-btn--ghost k-btn--sm" onClick={onClose}>
          <ArrowLeft size={14} aria-hidden /> Back
        </button>
        <strong>Object types</strong>
      </div>
      <h3>Your types</h3>
      {custom.length === 0 ? (
        <p className="cv__hint">
          None yet. A custom type is a name and a set of fields, saved with this project.
        </p>
      ) : (
        <ul className="cv__list">
          {custom.map((t) => (
            <li key={t.id} className="cv__type-row">
              <span className="cv__type-name">
                <TypeIcon icon={t.icon} color={t.color} /> {t.name}
              </span>
              {!readOnly && (
                <>
                  <button
                    type="button"
                    className="k-btn k-btn--ghost k-btn--sm"
                    aria-label={`Edit ${t.name}`}
                    onClick={() => {
                      setError(null);
                      setDraft(toDraft(t));
                    }}
                  >
                    <Pencil size={14} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="k-btn k-btn--ghost k-btn--sm"
                    aria-label={`Delete ${t.name}`}
                    onClick={() => void remove(t.id)}
                  >
                    <Trash2 size={14} aria-hidden />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <button
          type="button"
          className="k-btn k-btn--secondary k-btn--sm"
          onClick={() => {
            setError(null);
            setDraft(toDraft(null));
          }}
        >
          <Plus size={14} aria-hidden /> New type
        </button>
      )}
      {error && (
        <small className="cv__field-error" role="alert">
          {error}
        </small>
      )}
      <h3>Built in</h3>
      <ul className="cv__list">
        {builtin.map((t) => (
          <li key={t.id} className="cv__type-row">
            <span className="cv__type-name">
              <TypeIcon icon={t.icon} color={t.color} /> {t.name}
            </span>
            <span className="cv__meta">{t.fields.length} fields</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
