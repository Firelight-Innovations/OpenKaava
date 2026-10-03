import { useEffect, useState } from "react";
import { Palette } from "lucide-react";
import { designBrief, openCanvasSettings, type DesignBrief } from "./rpc";
import type { DesignOverride } from "./scene";

interface Props {
  canvasId: string;
  /** What the open canvas carries (`kaava.design`); nothing means it follows Settings. */
  override: DesignOverride | undefined;
  readOnly: boolean;
  onChange: (key: keyof DesignOverride, choice: string | null) => void;
}

const FOLLOW = "";

/**
 * The per-canvas override for the detail level and drawing style: two selects whose
 * first option is "follow Settings", which is what an unset choice means. What each
 * one resolves to comes from `canvas/design-brief`, so this never restates the
 * fallback rules that live in `style.rs`.
 */
export default function DesignControl({ canvasId, override, readOnly, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState<DesignBrief | null>(null);
  const detail = override?.detail ?? FOLLOW;
  const style = override?.style ?? FOLLOW;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void designBrief(canvasId)
      .then((b) => alive && setBrief(b))
      .catch(() => alive && setBrief(null));
    return () => {
      alive = false;
    };
  }, [open, canvasId, detail, style]);

  const nameOf = (id: string) => brief?.options.names[id] ?? id;
  const row = (
    label: string,
    key: keyof DesignOverride,
    value: string,
    ids: string[],
    effective: { id: string; from: string } | undefined,
  ) => (
    <label className="cv__design-row">
      <span>{label}</span>
      <select
        className="cv__select"
        value={value}
        disabled={readOnly}
        onChange={(e) => onChange(key, e.target.value === FOLLOW ? null : e.target.value)}
      >
        <option value={FOLLOW}>
          {value === FOLLOW && effective
            ? `Follow Settings (${nameOf(effective.id)})`
            : "Follow Settings"}
        </option>
        {ids.map((id) => (
          <option key={id} value={id}>
            {nameOf(id)}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="cv__design">
      <button
        type="button"
        className="k-btn k-btn--ghost k-btn--sm"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Detail level and drawing style for this canvas"
      >
        <Palette size={14} aria-hidden /> Drawing style
        {(detail !== FOLLOW || style !== FOLLOW) && <span className="cv__design-dot" />}
      </button>
      {open && (
        <div className="cv__design-pop" role="group" aria-label="Drawing style for this canvas">
          {row("Detail", "detail", detail, brief?.options.detail ?? [], brief?.detail)}
          {row("Style", "style", style, brief?.options.style ?? [], brief?.style)}
          <p className="cv__design-note">
            This canvas only. &quot;Follow Settings&quot; uses what you chose in Settings, Canvas.
          </p>
          <button
            type="button"
            className="k-btn k-btn--ghost k-btn--sm"
            onClick={() => void openCanvasSettings().catch(() => undefined)}
          >
            Open Settings
          </button>
        </div>
      )}
    </div>
  );
}
