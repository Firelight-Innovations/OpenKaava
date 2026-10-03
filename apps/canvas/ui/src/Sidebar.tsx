/**
 * The canvas app's own panels, docked beside the drawing instead of floating
 * over it: Diagrams, Comments and the Inspector (frame link, spec card,
 * reference images). Collapsing it leaves a strip of tab icons, so the drawing
 * gets the whole width back without losing the way in.
 *
 * Rejected: the floating boxes this replaces (`.cv__frame`, `.cv__spec`). They
 * covered the part of the drawing a person had just selected, and hid
 * Excalidraw's own menus at narrow widths.
 *
 * The hide button is pinned to the end of the tab row and never shrinks; the
 * tabs give way instead, first truncating their labels and then, below a
 * container width, showing icons only (App.css). Rejected: letting the row
 * wrap, which moves the button somewhere different at every width.
 */
import type { ReactNode } from "react";
import { Info, MessageSquare, PanelRightClose, PanelRightOpen, Shapes } from "lucide-react";

export type SideTab = "diagrams" | "comments" | "inspector";

const TABS: { id: SideTab; label: string; icon: typeof Info }[] = [
  { id: "inspector", label: "Inspector", icon: Info },
  { id: "diagrams", label: "Diagrams", icon: Shapes },
  { id: "comments", label: "Comments", icon: MessageSquare },
];

interface Props {
  tab: SideTab;
  onTab: (tab: SideTab) => void;
  collapsed: boolean;
  onCollapsed: (collapsed: boolean) => void;
  /** Shown on the Comments tab when there are open comments. */
  openComments: number;
  children: ReactNode;
}

export default function Sidebar({
  tab,
  onTab,
  collapsed,
  onCollapsed,
  openComments,
  children,
}: Props) {
  const Toggle = collapsed ? PanelRightOpen : PanelRightClose;
  return (
    <aside className={`cv__side${collapsed ? " is-collapsed" : ""}`} aria-label="Canvas panels">
      <div
        className="cv__side-bar"
        role="tablist"
        aria-orientation={collapsed ? "vertical" : "horizontal"}
      >
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={!collapsed && tab === id}
            className={`cv__side-tab${!collapsed && tab === id ? " is-on" : ""}`}
            title={label}
            onClick={() => {
              onTab(id);
              onCollapsed(false);
            }}
          >
            <Icon size={14} aria-hidden />
            {!collapsed && <span className="cv__side-label">{label}</span>}
            {id === "comments" && openComments > 0 && (
              <span className="cv__count" aria-label={`${openComments} open`}>
                {openComments}
              </span>
            )}
          </button>
        ))}
        <button
          type="button"
          className="cv__side-tab cv__side-toggle"
          title={collapsed ? "Show panels" : "Hide panels"}
          aria-label={collapsed ? "Show panels" : "Hide panels"}
          onClick={() => onCollapsed(!collapsed)}
        >
          <Toggle size={14} aria-hidden />
        </button>
      </div>
      {!collapsed && (
        <div className="cv__side-body" role="tabpanel">
          {children}
        </div>
      )}
    </aside>
  );
}
