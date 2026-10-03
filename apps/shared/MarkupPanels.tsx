/**
 * The two small surfaces markup adds around the 3D view: the one-time offer to
 * make sending automatic, and the larger look at the last markup and the frame
 * it was drawn on.
 */
import { X } from "lucide-react";
import type { PointerEvent } from "react";
import type { MarkupJson } from "@kaava/markup";
import { markupSummary } from "./markupFlow";
import "./markup.css";

/** Non-blocking: sits over the corner of the viewer and asks nothing of the person. */
export function MarkupTip({
  onEnable,
  onNever,
  onClose,
}: {
  onEnable: () => void;
  onNever: () => void;
  onClose: () => void;
}) {
  return (
    <div className="k-markup__tip" role="status">
      <p className="k-markup__tip-text">
        Markup sent. You can make this automatic, so pressing Done attaches it and types the
        reference at the agent's prompt without another click. It is a setting under Markup.
      </p>
      <div className="k-markup__tip-actions">
        <button type="button" className="k-markup__action" onClick={onEnable}>
          Send automatically
        </button>
        <button type="button" className="k-markup__action" onClick={onNever}>
          Don&apos;t show again
        </button>
        <button type="button" className="k-markup__tip-close" aria-label="Close" onClick={onClose}>
          <X size={13} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** The kept picture, full size, with the notes that were pinned to it. */
export function PreviousMarkup({
  url,
  json,
  savedAt,
  onClose,
}: {
  url: string;
  json: MarkupJson;
  savedAt: number | null;
  onClose: () => void;
}) {
  return (
    <div className="k-markup__previous" role="dialog" aria-label="Previous markup">
      <div className="k-markup__previous-head">
        <strong>Previous markup</strong>
        <span className="k-markup__summary">
          {markupSummary(json)}
          {savedAt ? `, drawn ${new Date(savedAt).toLocaleString()}` : ""}
        </span>
        <button type="button" className="k-markup__tip-close" aria-label="Close" onClick={onClose}>
          <X size={13} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <img className="k-markup__previous-image" alt="The frame the markup was drawn on" src={url} />
      {json.pins.length > 0 && (
        <ol className="k-markup__previous-notes">
          {json.pins.map((pin) => (
            <li key={pin.n} value={pin.n}>
              {pin.note || "(no note)"}
              {pin.nodePath ? <code> {pin.nodePath}</code> : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The markup just drawn, or read back from disk, under the 3D view: look closer, hide, or drag it to a terminal. */
export function MarkupBar({
  url,
  json,
  fresh,
  open,
  onOpenChange,
  onView,
  onPointerDown,
}: {
  url: string;
  json: Pick<MarkupJson, "pins" | "annotations">;
  /** Drawn this session, rather than kept from an earlier one. */
  fresh: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onView: () => void;
  onPointerDown: (event: PointerEvent<HTMLImageElement>) => void;
}) {
  if (!open) {
    return (
      <div className="k-markup__bar-kept">
        <button type="button" className="k-markup__action" onClick={() => onOpenChange(true)}>
          Previous markup
        </button>
      </div>
    );
  }
  return (
    <div className="k-markup__bar-kept" role="status">
      <img
        className="k-markup__thumb"
        alt="The markup you drew"
        src={url}
        draggable={false}
        title="Drag onto a terminal to send to the agent, or click to look closer"
        onClick={onView}
        onPointerDown={onPointerDown}
      />
      <span className="k-markup__summary">
        {fresh ? "Markup ready" : "Previous markup"}: {markupSummary(json)}
      </span>
      <button type="button" className="k-markup__action" onClick={onView}>
        View
      </button>
      <button type="button" className="k-markup__action" onClick={() => onOpenChange(false)}>
        Hide
      </button>
    </div>
  );
}
