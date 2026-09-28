import { Search } from "lucide-react";
import "./hindsightpage.css";

/**
 * Hindsight's docked body. There is no app behind it yet -- nothing in this
 * build ever answers on `:8888` -- so board 11's layout (recall search,
 * memory banks, activity) is drawn honestly empty rather than with invented
 * banks or events. `usePages`/`pages.rs` still lists the page: the rail
 * button opens this, and this says plainly that it has nothing to show yet.
 */
export default function HindsightPage() {
  return (
    <div className="k-hindsight">
      <div className="k-hindsight__search" aria-disabled="true">
        <Search size={13} strokeWidth={1.5} aria-hidden />
        <span>Recall from memory…</span>
      </div>

      <section className="k-hindsight__section">
        <h3 className="k-hindsight__heading">Memory banks</h3>
        <p className="k-hindsight__empty">Not connected in this build.</p>
      </section>

      <section className="k-hindsight__section">
        <h3 className="k-hindsight__heading">Activity</h3>
        <p className="k-hindsight__empty">Not connected in this build.</p>
      </section>
    </div>
  );
}
