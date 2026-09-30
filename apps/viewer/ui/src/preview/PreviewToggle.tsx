/**
 * The visible half of the Preview feature: a button for those who do not know
 * the shortcut, and the place the shortcut is written down.
 *
 * Renders nothing unless the active file has a rendered form, so it costs the
 * tab row nothing for a `.rs`. It reads the control `Viewer` publishes — see
 * `previewControl.ts` — and is the only thing here `App.tsx` mounts.
 */
import { useSyncExternalStore } from "react";
import { Eye, PanelRight } from "lucide-react";
import { previewControl, subscribePreviewControl } from "./previewControl";
import { KIND_LABEL, PREVIEW_SHORTCUT, PREVIEW_SIDE_SHORTCUT } from "./previewKind";
import "./toggle.css";

export default function PreviewToggle() {
  const control = useSyncExternalStore(subscribePreviewControl, previewControl);
  if (!control) return null;

  const label = KIND_LABEL[control.kind];
  const showing = control.mode !== "source";

  return (
    <div className="previewbtn" role="group" aria-label={`${label} preview`}>
      <button
        type="button"
        className="k-btn k-btn--secondary k-btn--sm previewbtn__btn"
        aria-pressed={control.mode === "preview"}
        onClick={control.toggle}
        title={
          showing
            ? `Back to the source (${PREVIEW_SHORTCUT})`
            : `Open ${label} preview (${PREVIEW_SHORTCUT})`
        }
      >
        <Eye size={13} aria-hidden="true" />
        Preview
      </button>
      <button
        type="button"
        className="k-btn k-btn--secondary k-btn--sm k-btn--icon previewbtn__btn"
        aria-pressed={control.mode === "side"}
        aria-label="Open preview to the side"
        onClick={control.toggleSide}
        title={`Open ${label} preview to the side (${PREVIEW_SIDE_SHORTCUT})`}
      >
        <PanelRight size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
