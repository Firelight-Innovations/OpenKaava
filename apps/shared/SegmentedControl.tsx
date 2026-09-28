/**
 * The small pill-group control every header in this workstream uses: Scene/Play
 * in the Godot Viewer, Model/Renders/Wire in the Blender Viewer. One component
 * so the three apps don't each hand-roll their own button row with slightly
 * different keyboard handling.
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
    <div className="k-segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={opt.value === value}
          className={`k-segmented__option${opt.value === value ? " k-segmented__option--active" : ""}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
