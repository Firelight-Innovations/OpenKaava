import { BrandGlyph } from "../../ui/Icon";

/**
 * Reached when the active cluster has nothing open — on first launch, and after
 * the last tab in it is closed or dragged away. Measured from SCREEN 02
 * (docs/handoffs/shell-spec.html). No dashed inset border here — that belongs to
 * the boot overlay only; screen 02's markup draws none.
 *
 * One button: "Open an app", which raises the same picker the `+` on a pane's
 * tab strip does. The copy names the other two ways in — the Apps menu, and a
 * drag from another cluster. It used to point at the `+` at the end of the
 * cluster's tabs, which makes a whole new cluster and not an app.
 */
export default function EmptyState({ onOpenApp }: { onOpenApp?: () => void }) {
  return (
    <div className="toolwindow__empty">
      <div className="toolwindow__empty-column">
        <BrandGlyph size={38} className="toolwindow__empty-glyph" />
        <div className="toolwindow__empty-title">Nothing open here</div>
        <div className="toolwindow__empty-body">
          Open an app to get started, pick one from the Apps menu in the title bar, or drag one in
          from another cluster.
        </div>
        {onOpenApp && (
          <button type="button" className="toolwindow__empty-action" onClick={onOpenApp}>
            Open an app
          </button>
        )}
      </div>
    </div>
  );
}
