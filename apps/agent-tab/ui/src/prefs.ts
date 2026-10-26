/**
 * The settings a new agent tab starts with: the harness, model, effort and
 * mode the user last picked in any tab. Kept in the frame's own storage, so a
 * new tab, a reload and the next launch all open where the user left off.
 */
import type { Harness } from "./protocol.generated";

export interface AgentPrefs {
  harness?: Harness;
  /** `null` is the agent's default model. */
  model?: string | null;
  effort?: string | null;
  ultracode?: boolean;
  /** The mode each harness's sessions start in. */
  modes?: Partial<Record<Harness, string>>;
}

const KEY = "veistra.agent-tab.prefs";

export function loadPrefs(): AgentPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as AgentPrefs) : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into what is kept; storage that refuses is not an error. */
export function savePrefs(patch: AgentPrefs): void {
  const now = loadPrefs();
  const next = { ...now, ...patch, modes: { ...now.modes, ...patch.modes } };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A private or full store only means the next tab starts from defaults.
  }
}
