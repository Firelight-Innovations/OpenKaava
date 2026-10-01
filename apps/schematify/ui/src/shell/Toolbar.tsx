/**
 * The Service Schematic toolbar (PRD §12.1): `Auto-sort` and `Fit`.
 *
 * The node search is not drawn here. Under the shell the search field is the
 * title bar's, shared by every surface; when Wave 8 builds node search it claims
 * that field with `claimSearch` from `@openkaava/bridge` instead of adding a
 * second bar. Until then there is nothing to type into, so nothing is shown.
 */
export interface ToolbarProps {
  onAutoSort?: () => void;
  onFit?: () => void;
}

export function Toolbar({ onAutoSort, onFit }: ToolbarProps) {
  return (
    <div className="kv-toolbar">
      <button
        type="button"
        className="kv-toolbar__button"
        disabled={!onAutoSort}
        onClick={onAutoSort}
      >
        Auto-sort
      </button>
      <button type="button" className="kv-toolbar__button" disabled={!onFit} onClick={onFit}>
        Fit
      </button>
    </div>
  );
}
