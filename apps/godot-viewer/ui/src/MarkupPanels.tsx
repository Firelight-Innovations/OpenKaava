/**
 * The two small surfaces markup adds around the 3D view: the one-time offer to
 * make sending automatic, and the larger look at the last markup and the frame
 * it was drawn on.
 */
import { X } from "lucide-react";
import type { MarkupJson } from "@kaava/markup";
import { markupSummary } from "./markupFlow";

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
    <div className="gv__tip" role="status">
      <p className="gv__tip-text">
        Markup sent. You can make this automatic, so pressing Done sends it to the agent without
        another click. It is a setting under Godot.
      </p>
      <div className="gv__tip-actions">
        <button type="button" className="gv__action" onClick={onEnable}>
          Send automatically
        </button>
        <button type="button" className="gv__action" onClick={onNever}>
          Don&apos;t show again
        </button>
        <button type="button" className="gv__tip-close" aria-label="Close" onClick={onClose}>
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
    <div className="gv__previous" role="dialog" aria-label="Previous markup">
      <div className="gv__previous-head">
        <strong>Previous markup</strong>
        <span className="gv__markup-summary">
          {markupSummary(json)}
          {savedAt ? `, drawn ${new Date(savedAt).toLocaleString()}` : ""}
        </span>
        <button type="button" className="gv__tip-close" aria-label="Close" onClick={onClose}>
          <X size={13} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <img className="gv__previous-image" alt="The frame the markup was drawn on" src={url} />
      {json.pins.length > 0 && (
        <ol className="gv__previous-notes">
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
