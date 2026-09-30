import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ClipboardCopy, Trash2 } from "lucide-react";
import type { ContextRef } from "../../../shared/context";
import { SendButton } from "../../../shared/SendFooter";
import { dragContext } from "./sendToAgent";
import {
  STATUSES,
  cardToDraft,
  draftToCard,
  exportDraft,
  validateDraft,
  type SpecCard,
  type SpecDraft,
  type SpecStatus,
} from "./spec";

interface Props {
  /** The card stored on the selected element, or `null` when it has none. */
  stored: Record<string, unknown> | null;
  readOnly: boolean;
  onSave: (card: SpecCard) => void;
  onRemove: () => void;
  /** Put the card's JSON where the agent reads it. */
  putCard: (name: string, json: string) => Promise<ContextRef>;
  onSendError: (message: string) => void;
  /** The shared footer's slot: Send card renders there, not in the panel. */
  sendSlot: HTMLElement | null;
  /** This canvas's stored reference images, offered as one-click links. */
  refs?: { name: string; path: string }[];
}

/**
 * The spec inspector for the selected element (board 12): the five fields of
 * `docs/cloud-services.md` §4 plus the card's review state. Remount it (`key`)
 * per element, so a draft never leaks from one card to another.
 */
export default function SpecPanel({
  stored,
  readOnly,
  onSave,
  onRemove,
  putCard,
  onSendError,
  sendSlot,
  refs = [],
}: Props) {
  const [draft, setDraft] = useState<SpecDraft>(() => cardToDraft(stored));
  const [touched, setTouched] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const issues = useMemo(() => validateDraft(draft), [draft]);
  const exported = useMemo(() => exportDraft(draft), [draft]);
  const show = touched || stored !== null;
  const set = <K extends keyof SpecDraft>(key: K, value: SpecDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setCopied(null);
  };

  const save = () => {
    setTouched(true);
    const card = draftToCard(draft);
    if (card) onSave(card);
  };

  const copy = async () => {
    setTouched(true);
    if (!exported.ok) return;
    try {
      await navigator.clipboard.writeText(exported.json);
      setCopied("Copied the JSON.");
    } catch {
      setCopied("The clipboard is not available. Select the JSON below and copy it.");
    }
  };

  const sendCard = () => {
    setTouched(true);
    if (!exported.ok) return;
    putCard(draft.name.trim(), exported.json).then(
      () => {
        setSent(true);
        setTimeout(() => setSent(false), 1800);
      },
      (err: unknown) =>
        onSendError(
          `Couldn't send the card to the agent: ${err instanceof Error ? err.message : String(err)}`,
        ),
    );
  };

  const field = (
    label: string,
    key: "name" | "size_m" | "triangle_budget",
    extra?: { inputMode?: "decimal" | "numeric"; placeholder?: string },
  ) => (
    <div className="cv__field">
      <label htmlFor={`spec-${key}`}>{label}</label>
      <input
        id={`spec-${key}`}
        className="cv__input"
        value={draft[key]}
        disabled={readOnly}
        inputMode={extra?.inputMode}
        placeholder={extra?.placeholder}
        aria-invalid={show && issues[key] ? true : undefined}
        aria-describedby={show && issues[key] ? `spec-${key}-err` : undefined}
        onChange={(e) => set(key, e.target.value)}
      />
      {show && issues[key] && (
        <small id={`spec-${key}-err`} className="cv__field-error">
          {issues[key]}
        </small>
      )}
    </div>
  );

  return (
    <section className="cv__spec" aria-label="Spec card">
      <div className="cv__spec-head">
        <strong>{stored ? "Spec card" : "Make a spec card"}</strong>
        <span className={`cv__state cv__state--${draft.status}`}>{draft.status}</span>
      </div>
      {field("Name", "name", { placeholder: "Anomaly chair" })}
      {field("Size (m, largest side)", "size_m", { inputMode: "decimal", placeholder: "1.2" })}
      {field("Triangle budget", "triangle_budget", { inputMode: "numeric", placeholder: "5000" })}
      <label className="cv__field">
        <span>Style notes</span>
        <textarea
          className="cv__input"
          rows={3}
          value={draft.style_notes}
          disabled={readOnly}
          onChange={(e) => set("style_notes", e.target.value)}
        />
      </label>
      <label className="cv__field">
        <span>Reference images (one path or URL per line)</span>
        <textarea
          className="cv__input"
          rows={3}
          value={draft.reference_images}
          disabled={readOnly}
          onChange={(e) => set("reference_images", e.target.value)}
        />
      </label>
      {!readOnly && refs.length > 0 && (
        <div className="cv__row" role="group" aria-label="Link a stored reference image">
          {refs
            .filter((r) => !draft.reference_images.split("\n").some((l) => l.trim() === r.path))
            .map((r) => (
              <button
                key={r.path}
                type="button"
                className="cv__chip"
                title={r.path}
                onClick={() =>
                  set(
                    "reference_images",
                    [draft.reference_images.trim(), r.path].filter(Boolean).join("\n"),
                  )
                }
              >
                + {r.name}
              </button>
            ))}
        </div>
      )}
      <label className="cv__field">
        <span>Review state</span>
        <select
          className="cv__select"
          value={draft.status}
          disabled={readOnly}
          onChange={(e) => set("status", e.target.value as SpecStatus)}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <div className="cv__spec-actions">
        {!readOnly && (
          <button type="button" className="k-btn k-btn--primary k-btn--sm" onClick={save}>
            Save card
          </button>
        )}
        <button
          type="button"
          className="k-btn k-btn--secondary k-btn--sm"
          onClick={() => void copy()}
        >
          <ClipboardCopy size={14} aria-hidden /> Copy JSON
        </button>
        {sendSlot &&
          createPortal(
            <SendButton
              label="Send card"
              sent={sent}
              disabled={!exported.ok}
              title="Add this card, as JSON, to the agent's context. Drag to a terminal to send it."
              onPointerDown={
                exported.ok
                  ? dragContext(() => putCard(draft.name.trim(), exported.json))
                  : undefined
              }
              onClick={sendCard}
            />,
            sendSlot,
          )}
        {!readOnly && stored && (
          <button type="button" className="k-btn k-btn--ghost k-btn--sm" onClick={onRemove}>
            <Trash2 size={14} aria-hidden /> Remove
          </button>
        )}
      </div>
      {copied && <small role="status">{copied}</small>}
      {exported.ok && (
        <pre className="cv__json" aria-label="Exported JSON">
          {exported.json}
        </pre>
      )}
    </section>
  );
}
