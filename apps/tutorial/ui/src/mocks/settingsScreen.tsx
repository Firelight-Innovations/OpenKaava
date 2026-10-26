/** The settings screen: the categories rail, and a couple of controls in the
 *  section picked in it — see `src/shell/settings/SettingsScreen.tsx`. Six
 *  sections in the order `schema.rs`'s groups sort by (`order`, then `id`):
 *  five of the shell's own, plus the one the File Explorer registers for
 *  itself — see `settings.ts`'s "What is in there today". */
import { Col, MockWindow, Row } from "./chrome";

const SECTIONS = ["Appearance", "Editor", "Terminal", "Search", "MCP servers", "File Explorer"];

export default function SettingsScreen() {
  return (
    <Row gap="sm">
      <MockWindow title="Sections">
        <Col gap="xs">
          {SECTIONS.map((section) => {
            const selected = section === "MCP servers";
            return (
              <span
                key={section}
                className={selected ? "tut__mock-tab tut__mock-tab--selected" : "tut__mock-tab"}
              >
                {section}
              </span>
            );
          })}
        </Col>
      </MockWindow>

      {/* `McpPanel.tsx` is the one section with a custom panel: an endpoint
          line above the schema-drawn rows, not a setting itself. "Echo" is
          the one server this build hosts — see `mcp/servers/echo.rs` — and
          the toggle below it is the actual schema setting,
          `mcp.writeProjectConfig`, drawn the same way every other section's
          rows are. */}
      <MockWindow title="MCP servers" className="tut__mock-grow">
        <Col gap="sm">
          <Row gap="xs" align="center">
            <span className="tut__mock-dot tut__mock-dot--ok" />
            <span className="tut__mock-caption">Listening on 127.0.0.1:8420</span>
          </Row>
          <Row justify="between" align="center">
            <span className="tut__mock-caption">Echo</span>
            <span className="tut__mock-toggle tut__mock-toggle--on" />
          </Row>
          <Row justify="between" align="center">
            <span className="tut__mock-caption">Write .mcp.json into open projects</span>
            <span className="tut__mock-toggle tut__mock-toggle--on" />
          </Row>
        </Col>
      </MockWindow>
    </Row>
  );
}
