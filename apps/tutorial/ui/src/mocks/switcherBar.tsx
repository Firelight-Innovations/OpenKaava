/** The cluster switcher: the title bar's centred pill, and the list of clusters
 *  it opens. See `src/shell/titlebar/ClusterSwitcher.tsx`; the rail's badge
 *  strip is `src/shell/rail/ClusterStrip.tsx`. */
import { Band, MockTab, Row } from "./chrome";

export default function SwitcherBar() {
  return (
    <Band tone="surface">
      <div className="tut__mock-grow" />
      <Row gap="xs">
        <MockTab label="Anvil · auth" selected />
        <MockTab label="Website · billing" />
        <span className="tut__mock-btn">+</span>
      </Row>
      <div className="tut__mock-grow" />
    </Band>
  );
}
