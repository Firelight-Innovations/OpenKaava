import { motion } from "framer-motion";
import type { ToolHealth, ToolPresentation } from "../contract";
import { HEALTH_LABEL, HEALTH_TOKEN } from "../contract";
import { popover } from "../motion";
import "./toolHealth.css";

/** A presentation whose health has already been narrowed away from "ok". */
export type UnhealthyTool = ToolPresentation & { health: Exclude<ToolHealth, "ok"> };

/**
 * The only place tool state appears. One row per unhealthy tool — a healthy
 * tool is silent here exactly like it is silent on its tab.
 */
export default function HealthPopover({
  tools,
  onRescan,
}: {
  tools: UnhealthyTool[];
  onRescan: () => void;
}) {
  return (
    <motion.div
      className="toolhealth__popover"
      variants={popover}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <div className="toolhealth__popover-header">TOOL HEALTH</div>
      {tools.map((tool) => (
        <div key={tool.id} className="toolhealth__popover-row">
          <span
            className="toolhealth__popover-dot"
            style={{ background: HEALTH_TOKEN[tool.health] }}
          />
          <span className="toolhealth__popover-name">{tool.name}</span>
          <span className="toolhealth__popover-spacer" />
          {/* Always the user-facing word from HEALTH_LABEL — never the
              backend's "mismatch" / "unversioned" / "missing". */}
          <span className="toolhealth__popover-state">{HEALTH_LABEL[tool.health]}</span>
        </div>
      ))}
      <button type="button" className="toolhealth__popover-rescan" onClick={onRescan}>
        Re-scan tools
      </button>
    </motion.div>
  );
}
