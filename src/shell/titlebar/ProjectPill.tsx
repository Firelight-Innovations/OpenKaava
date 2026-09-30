/**
 * The title bar's centred pill: which project, and which environment.
 *
 * `docs/design/KAAVA-UX-SPEC.md` §1.2. A 16×16 tile (the project's own icon,
 * or its initial), the project's
 * name, then either `· N environments` (no cluster active — U-Anatomy and
 * U-Workspace's idle state) or a mono chip naming the active cluster's
 * environment, then a chevron. Clicking it opens the Switch-project dialog;
 * see `TitleBarProps.onOpenProjectSwitcher` for why that is still a no-op
 * today and the button is real regardless.
 */
import { ChevronDown, Cloud, GitBranch, Lock } from "lucide-react";
import type { Environment, EnvironmentKind } from "../environment";
import ProjectTile from "../ProjectTile";
import "./projectPill.css";

const KIND_ICON: Record<EnvironmentKind, typeof GitBranch> = {
  worktree: GitBranch,
  design: GitBranch,
  cloud: Cloud,
  main: Lock,
};

export default function ProjectPill({
  project,
  environment,
  environmentLabel,
  environmentCount,
  icon = null,
  onOpenSwitcher,
}: {
  project: string;
  /** The project's own icon as a `data:` URL; `null` draws the initial. */
  icon?: string | null;
  environment: Environment | null;
  environmentLabel: string | null;
  environmentCount: number;
  onOpenSwitcher?: () => void;
}) {
  const Glyph = environment ? KIND_ICON[environment.kind] : null;

  return (
    <button type="button" className="projectpill" onClick={onOpenSwitcher} title={project}>
      <ProjectTile name={project} icon={icon} className="projectpill__tile" />
      <span className="projectpill__name">{project}</span>

      {environment === null ? (
        environmentCount > 0 && (
          <span className="projectpill__count">
            · {environmentCount} {environmentCount === 1 ? "environment" : "environments"}
          </span>
        )
      ) : (
        <span className="projectpill__chip">
          {Glyph && <Glyph size={11} strokeWidth={1.5} className="projectpill__chip-icon" />}
          {environmentLabel ?? environment.branch ?? environment.kind}
        </span>
      )}

      <ChevronDown size={12} strokeWidth={1.5} className="projectpill__chevron" />
    </button>
  );
}
