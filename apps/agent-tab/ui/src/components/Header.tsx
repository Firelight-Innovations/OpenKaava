import { strings } from "../strings";
import { useSlots } from "./registry";
import type { HeaderProps } from "./types";
import "./frame.css";

export function Header({ cwd, state, onNewSession }: HeaderProps) {
  const S = useSlots();
  return (
    <header className="at-header">
      <span className="at-header__title">{strings.title}</span>
      <span className="at-chip">{strings.harness.claude}</span>
      {cwd !== null && (
        <span className="at-chip at-mono" title={cwd}>
          {strings.environment(baseName(cwd))}
        </span>
      )}
      <S.StatusBadge state={state} />
      <span className="at-header__spacer" />
      <button
        type="button"
        className="k-btn k-btn--ghost k-btn--sm"
        title={strings.newSessionHint}
        onClick={onNewSession}
      >
        {strings.newSession}
      </button>
    </header>
  );
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
