/** The status bar's git controls, in the order `StatusBar.tsx` draws them: the
 *  branch segment (branch, arrows and diff stat in one button) on the left,
 *  then GitHub status on the right. The project name and environment chip
 *  before the branch are left out, so the two buttons are what the eye finds.
 *  The stack's health list lives behind the switcher bar's warning badge
 *  instead (`HealthPopover.tsx`), not here — see the `stack-list` mock. */
import { Band } from "./chrome";

export default function StatusBar() {
  return (
    <Band tone="surface">
      <span className="tut__mock-btn">main ↑1 ↓0 · +142 -63 · 9 files</span>

      <div className="tut__mock-grow" />

      <span className="tut__mock-dot tut__mock-dot--ok" />
      <span className="tut__mock-btn">GitHub</span>
    </Band>
  );
}
