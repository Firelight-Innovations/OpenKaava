/**
 * The small pill-group control every header in this workstream uses: Scene/Play
 * in the Godot Viewer, Model/Renders/Wire in the Blender Viewer. Markup follows
 * the design system's own Tabs component (`src/kaava-ui.css`'s `.k-tabs--segmented`
 * variant — `.k-tabs[role=tablist]` wrapping `.k-tab[role=tab]` children) rather
 * than a hand-rolled equivalent, per `docs/design-notes/` (see
 * `tokens-merged.md`'s note to use the shared classes where they fit).
 */
export interface SegmentedControlProps<T extends string> {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  "aria-label": string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div className="k-tabs k-tabs--segmented" role="tablist" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={opt.value === value}
          className="k-tab"
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
