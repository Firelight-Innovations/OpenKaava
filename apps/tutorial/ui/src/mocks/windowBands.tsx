/** The whole OpenKaava window, four bands stacked and each one named — the picture
 *  `theWindow.ts` is a transcript of. Its own six-menu list is repeated here
 *  rather than imported from `titleBar.tsx`, the same way that file states its
 *  own — two small arrays are cheaper than a cross-mock import for a picture. */
import type { ReactNode } from "react";
import { PRODUCT_NAME } from "../branding.generated";
import { ArrowCallout, Band, Col, Row } from "./chrome";

const MENUS = ["File", "Edit", "View", "Run", "Terminal", "Help"];

export default function WindowBands() {
  return (
    <Col gap="xs">
      <Labelled label="Title bar">
        <Band tone="surface">
          <Row gap="xs">
            {MENUS.map((menu) => (
              <span key={menu} className="tut__mock-caption">
                {menu}
              </span>
            ))}
          </Row>
          <Row justify="center" className="tut__mock-grow">
            <span className="tut__mock-caption">{PRODUCT_NAME} | Anvil</span>
          </Row>
          <Row gap="xs">
            <span className="tut__mock-btn">—</span>
            <span className="tut__mock-btn">▢</span>
            <span className="tut__mock-btn">×</span>
          </Row>
        </Band>
      </Labelled>

      <Labelled label="Tool window">
        <div className="tut__mock-panebox tut__mock-panebox--tall">panes</div>
      </Labelled>

      <Labelled label="Terminal band">
        <Band tone="bg">
          <span className="tut__mock-tab tut__mock-tab--selected">bash</span>
          <span className="tut__mock-tab">bash 2</span>
        </Band>
      </Labelled>

      <Labelled label="Status bar">
        <Band tone="surface">
          <div className="tut__mock-grow" />
          <span className="tut__mock-caption">main</span>
          <span className="tut__mock-dot tut__mock-dot--ok" />
          <span className="tut__mock-caption">GitHub</span>
          <span className="tut__mock-btn">⚙</span>
        </Band>
      </Labelled>
    </Col>
  );
}

/** One band plus the callout naming it, repeated four times above. */
function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Row gap="sm" align="center">
      <div className="tut__mock-grow">{children}</div>
      <ArrowCallout dir="left" label={label} />
    </Row>
  );
}
