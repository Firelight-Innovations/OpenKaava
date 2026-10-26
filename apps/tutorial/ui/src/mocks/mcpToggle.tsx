/** An MCP server row with its toggle, and where turning it on writes — see
 *  `mcpServers.ts` and `src/shell/settings/McpPanel.tsx`. The meta line
 *  matches `ServerRow`'s own: config key, route, tool count — not the tool
 *  names themselves, which the settings panel never lists. */
import { Arrow, Col, MockWindow, Row } from "./chrome";

export default function McpToggle() {
  return (
    <Row gap="md" align="center">
      <MockWindow title="MCP servers" className="tut__mock-grow">
        <Row justify="between" align="center">
          <Col gap="xs">
            <span className="tut__mock-caption">Echo</span>
            <span className="tut__mock-caption">veistra-echo · /mcp/echo · 2 tools</span>
          </Col>
          <span className="tut__mock-toggle tut__mock-toggle--on" />
        </Row>
      </MockWindow>

      <Arrow dir="right" />

      <MockWindow title=".mcp.json" className="tut__mock-grow">
        <span className="tut__mock-caption">{'"veistra-echo": { ... }'}</span>
      </MockWindow>
    </Row>
  );
}
