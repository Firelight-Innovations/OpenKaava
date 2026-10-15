/**
 * The harnesses the settings menu lists, each with the models it offers.
 * The menu shows Claude, Codex and Kaava in that order. One the host does
 * not report reads "Coming soon": Kaava is our own harness and still being
 * built, and Codex arrives with harness-bridge.
 */
import type { HarnessInfo } from "./protocol.generated";
import type { HarnessChoice, PickerChoice } from "./components/types";
import { strings } from "./strings";

/** The menu's order. A harness the host reports beyond these follows them. */
export const HARNESSES = ["claude", "codex", "kaava"];

/**
 * What the host may add to a harness once it scans the harness for its
 * models. Not in the protocol yet: read when present, so the menu fills in
 * as soon as the host sends it.
 */
interface Scanned {
  models?: PickerChoice[];
  model?: string | null;
}

/** The running session's model setting: what it offers and what it runs. */
export interface RunningModel {
  models: PickerChoice[];
  model: string | null;
}

/**
 * Every harness, with its models. The one in use takes them from its running
 * session when there is one, since that is what the agent actually offers;
 * the rest take what the host scanned, or none.
 */
export function harnessChoices(
  reported: readonly HarnessInfo[],
  current: string | null,
  running: RunningModel | null,
): HarnessChoice[] {
  const ids = [...HARNESSES, ...reported.map((h) => h.harness as string)].filter(
    (id, i, all) => all.indexOf(id) === i,
  );
  return ids.map((id) => {
    const name = strings.harnessName[id] ?? id;
    const info = reported.find((h) => h.harness === id) as (HarnessInfo & Scanned) | undefined;
    if (!info) return { id, name, models: [], model: null, unavailable: strings.harnessSoon };
    const live = id === current ? running : null;
    return {
      id,
      name,
      models: live?.models ?? info.models ?? [],
      model: live ? live.model : (info.model ?? null),
      unavailable: null,
    };
  });
}
