/**
 * The title bar — logo, six menus (or their hamburger collapse), the
 * environment summary, the centred project pill, search and Review & merge,
 * and the three window controls.
 *
 * Menu geometry is lifted from `docs/handoffs/shell-spec.html` (search
 * `>File<`); the pill is `docs/design/KAAVA-UX-SPEC.md` §1.2 / board 08. The
 * environment summary and the two actions used to be a bar of their own below
 * the cluster switcher (§1.4) and a box on the switcher's right; they live here
 * now so the panes get that height. `titlebar.css` owns the collapse order.
 *
 * This component does not set the bar's height or background: `Frame` already
 * renders it into `.frame__titlebar`. Setting either here would be two owners
 * of one property.
 */
import type { ReactNode } from "react";
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
  /**
   * The environment summary (`EnvironmentBar`), drawn after the menus. Optional:
   * omitted while no cluster is open.
   */
  environmentSlot?: ReactNode;
  /** Search and Review & merge, right-aligned beside the window controls. */
  actionsSlot?: ReactNode;
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
  environmentSlot,
  actionsSlot,
}: TitleBarProps) {
  const narrow = useNarrowTitlebar();

  return (
    // Three cells on a grid whose outer tracks are equal (`titlebar.css`), so
    // the pill is centred on the window whatever the two sides hold. The drag
    // attribute is on the bar, the two cells, and every non-interactive
    // element inside them: Tauri applies it to the element that was pressed,
    // not its descendants, so a button never starts a drag and the gaps between
    // controls always do.
    <div
      className="titlebar"
      data-window-kind={kind}
      data-has-pill={project !== null || undefined}
      data-tauri-drag-region
    >
      <div className="titlebar__start" data-tauri-drag-region>
        <div className="titlebar__logo" data-tauri-drag-region>
          <BrandGlyph size={15} className="titlebar__logo-icon" />
        </div>

        {narrow ? <HamburgerMenu menus={menus} /> : <MenuBar menus={menus} />}

        {environmentSlot}
      </div>

      {/* Drawn only with a project open: a segment with no answer is dropped
          rather than shown as a placeholder pill with nothing in it. */}
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

      <div className="titlebar__end" data-tauri-drag-region>
        {actionsSlot}
        <WindowControls />
      </div>
    </div>
  );
}
