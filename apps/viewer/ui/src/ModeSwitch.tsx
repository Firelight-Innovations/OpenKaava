/**
 * The control that floats over the top-right of the file: Code | Preview | Steps.
 *
 * It replaces the tab row's trailing slot, which went with the tab row when a
 * File Viewer became one file. Preview appears only for a file with a rendered
 * form, read from `previewControl`; the small side button beside it is where
 * Ctrl+K V is written down. What each click does is in `modeRules.ts`.
 */
import { useSyncExternalStore } from "react";
import { PanelRight } from "lucide-react";
import { previewControl, subscribePreviewControl } from "./preview/previewControl";
import { KIND_LABEL, PREVIEW_SHORTCUT, PREVIEW_SIDE_SHORTCUT } from "./preview/previewKind";
import { activeSegment, planSegment, type Segment, type ViewMode } from "./modeRules";
import "./modeSwitch.css";

export default function ModeSwitch({
  view,
  onView,
}: {
  view: ViewMode;
  onView(next: ViewMode): void;
}) {
  const control = useSyncExternalStore(subscribePreviewControl, previewControl);
  const mode = control?.mode ?? null;
  const active = activeSegment(view, mode);

  const choose = (target: Segment) => {
    const plan = planSegment(target, mode);
    onView(plan.view);
    if (plan.toggle) control?.toggle();
  };

  const label = control ? KIND_LABEL[control.kind] : "";

  return (
    <div className="modeswitch">
      <div className="k-tabs k-tabs--segmented" role="tablist" aria-label="View">
        <button
          type="button"
          role="tab"
          aria-selected={active === "code"}
          className="k-tab"
          onClick={() => choose("code")}
        >
          Code
        </button>
        {control && (
          <button
            type="button"
            role="tab"
            aria-selected={active === "preview"}
            className="k-tab"
            onClick={() => choose("preview")}
            title={`Open ${label} preview (${PREVIEW_SHORTCUT})`}
          >
            Preview
          </button>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={active === "steps"}
          className="k-tab"
          onClick={() => choose("steps")}
          title="Not wired up yet. Planned: a step diagram for scripts like build_bed.py, each step commentable like a Blender mesh part."
        >
          Steps
        </button>
      </div>
      {control && (
        <button
          type="button"
          className="k-btn k-btn--secondary k-btn--sm k-btn--icon modeswitch__side"
          aria-pressed={control.mode === "side"}
          aria-label="Open preview to the side"
          onClick={control.toggleSide}
          title={`Open ${label} preview to the side (${PREVIEW_SIDE_SHORTCUT})`}
        >
          <PanelRight size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
