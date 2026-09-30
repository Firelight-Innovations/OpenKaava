/**
 * Minimise, maximise, close.
 *
 * The Tauri calls themselves live in `bindings.ts` now (STANDARDS.md §1.1 —
 * one door). `isTauri` is what's guarded here, right before every command —
 * it lives in `../hostWindow`, which is where the menu bar's window commands
 * are too, one definition of "is there a real window here", not two that
 * could drift.
 */
import { closeHostWindow, minimizeHostWindow, toggleHostMaximize } from "../../bindings";
import { isTauri } from "../hostWindow";
import { WindowClose, WindowMaximise, WindowMinimise, WindowRestore } from "../../ui/Icon";
import { maximizeControl } from "./maximizeControl";
import { useWindowMaximized } from "./useWindowMaximized";

function run(fn: () => Promise<unknown>) {
  return () => {
    if (!isTauri()) return;
    void fn();
  };
}

export default function WindowControls() {
  const maximize = maximizeControl(useWindowMaximized());
  return (
    <div className="titlebar__controls">
      <button
        type="button"
        className="titlebar__control"
        aria-label="Minimise"
        title="Minimise"
        onClick={run(minimizeHostWindow)}
      >
        <WindowMinimise />
      </button>
      <button
        type="button"
        className="titlebar__control"
        aria-label={maximize.label}
        title={maximize.label}
        onClick={run(toggleHostMaximize)}
      >
        {maximize.icon === "restore" ? <WindowRestore /> : <WindowMaximise />}
      </button>
      <button
        type="button"
        className="titlebar__control titlebar__control--close"
        aria-label="Close"
        title="Close"
        onClick={run(closeHostWindow)}
      >
        <WindowClose />
      </button>
    </div>
  );
}
