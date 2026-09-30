/**
 * A switch: a track that fills and a knob that travels.
 *
 * Deliberately not an `<input type="checkbox">` under a styled label. A checkbox
 * says "this will be true once you submit", and there is nothing here to submit
 * — the write leaves for Rust on the click and the row is already the state.
 * `role="switch"` is the ARIA element for exactly that, and a screen reader
 * reads it "on"/"off" rather than "checked", which is what the row means.
 *
 * Lives here rather than inside `SettingRow` because the MCP panel needs the
 * same switch on a row that is not a setting at all (`McpPanel.tsx`). One
 * component, so the two cannot drift into two switches.
 */
export default function ToggleControl({
  on,
  label,
  onChange,
}: {
  on: boolean;
  /**
   * What this switch is for. Never drawn — the row beside it carries the visible
   * title — so it exists purely so a screen reader landing on the button alone
   * still knows which setting it is holding.
   */
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="k-toggle"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      <span className="k-toggle__knob" />
    </button>
  );
}
