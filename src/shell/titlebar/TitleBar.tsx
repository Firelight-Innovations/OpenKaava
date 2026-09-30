/**
 * The title bar — logo, six menus (or their hamburger collapse), the centred
 * project pill, and the three window controls.
 *
 * Menu geometry is lifted from `docs/handoffs/shell-spec.html` (search
 * `>File<` and the `REFERENCE` table's Title bar row) rather than chosen —
 * see `titlebar.css`'s header comment for the one place that isn't. The pill
 * replaces this file's old plain-text title, per
 * `docs/design/KAAVA-UX-SPEC.md` §1.2 and board 08: `PRODUCT_NAME` no longer
 * appears here at all, because the mark to its left already says it, and the
 * centre of the bar is worth spending on the one fact the mark cannot say —
 * which project, and which environment.
 *
 * This component does not set the bar's height or background: `Frame` already
 * renders it into `.frame__titlebar`. Setting either here would be two owners
 * of one property.
 */
import type { Menu, WindowKind } from "../contract";
import type { Environment } from "../environment";
import { BrandGlyph } from "../../ui/Icon";
import MenuBar from "./MenuBar";
import HamburgerMenu from "./HamburgerMenu";
import WindowControls from "./WindowControls";
import { useNarrowTitlebar } from "./useNarrowTitlebar";
import ProjectPill from "./ProjectPill";
import "./titlebar.css";

export interface TitleBarProps {
  kind: WindowKind;
  /**
   * The **active cluster's** project name, or `null` when that cluster has none
   * — or when this window has no cluster at all. A project belongs to a cluster,
   * so this is what lets two windows name two projects at once. It comes from
   * `useClusterProject`, asked about whichever cluster this window is showing.
   */
  project: string | null;
  /** That project's own icon as a `data:` URL, or `null` for its initial. */
  projectIcon?: string | null;
  /**
   * The active cluster's environment, or `null` while no cluster is open. Drives
   * the pill's trailing chip — see `ProjectPill.tsx`.
   */
  environment: Environment | null;
  /**
   * What the chip names when `environment` is not `null`: the cluster's own
   * name. `docs/design/KAAVA-UX-SPEC.md` §1.2's own example ("godot-port") is a
   * cluster's short name rather than its full branch, which is what a person
   * actually recognises a cluster by — the branch is already on the switcher
   * tab and on the environment bar below it.
   */
  environmentLabel: string | null;
  /**
   * How many distinct environments this project's clusters cover, shown only
   * while `environment` is `null` — the pill's idle state (§1.2).
   */
  environmentCount: number;
  /**
   * Opens the Switch-project dialog. The **clusters** workstream builds that
   * dialog; until it exists this is the no-op `WindowRoot` supplies, and the
   * pill is still a real, clickable button rather than a dead one — pressing
   * it just has nothing to open yet.
   */
  onOpenProjectSwitcher?: () => void;
  /**
   * Built by `defaultMenus()`, wired against `WindowRoot`'s state and the active
   * app frame. Rebuilt on every render, because half the items read live state —
   * Save disables when nothing is dirty, the toggles say which way they will go.
   */
  menus: Menu[];
}

export default function TitleBar({
  kind,
  project,
  projectIcon = null,
  environment,
  environmentLabel,
  environmentCount,
  onOpenProjectSwitcher,
  menus,
}: TitleBarProps) {
  const narrow = useNarrowTitlebar();

  return (
    // The drag region lives on this element only. The logo, the menus, the
    // pill, and the window controls are all separate elements without the
    // attribute, so pointer-downs on them never start a window drag —
    // clicking through to this element's own background is what does.
    <div className="titlebar" data-window-kind={kind} data-tauri-drag-region>
      <div className="titlebar__logo">
        <BrandGlyph size={15} className="titlebar__logo-icon" />
      </div>

      {narrow ? <HamburgerMenu menus={menus} /> : <MenuBar menus={menus} />}

      {/* Absolutely centred across the whole bar, and deliberately allowed to
          sit under the menu block or the window controls at narrow widths —
          the spec calls that out by name for the title this pill replaces,
          and the placement rule carries over unchanged. Drawn only with a
          project open: a segment with no answer is dropped rather than shown
          as a placeholder pill with nothing in it. */}
      {project !== null && (
        <ProjectPill
          project={project}
          icon={projectIcon}
          environment={environment}
          environmentLabel={environmentLabel}
          environmentCount={environmentCount}
          onOpenSwitcher={onOpenProjectSwitcher}
        />
      )}

      <div className="titlebar__spacer" />

      <WindowControls />
    </div>
  );
}
