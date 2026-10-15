/**
 * The harnesses the settings menu lists, each with the models it offers.
 * The menu shows Claude, Codex and Kaava in that order. One the host does
 * not report reads "Coming soon": Kaava is our own harness and still being
 * built, and Codex arrives with harness-bridge. The harness in use is never
 * locked, even before the host's answer arrives.
 */
import type { HarnessInfo } from "./protocol.generated";
import type { HarnessChoice, PickerChoice } from "./components/types";
import { strings } from "./strings";

/** The menu's order. A harness the host reports beyond these follows them. */
export const HARNESSES = ["claude", "codex", "kaava"];

/**
 * What the host adds to a harness once it scans it for its models, as
 * harness-bridge proposed it. Not in the protocol yet: read when present, so
 * the menu fills in as soon as the host sends it. `models` is `null` until a
 * scan has run; `model` is the value the next session starts with.
 */
interface Scanned {
  models?: PickerChoice[] | null;
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
    const inUse = id === current;
    const live = inUse ? running : null;
    // The one in use is running, or about to: whatever the host has said so far.
    const unavailable = inUse
      ? null
      : !info
        ? strings.harnessSoon
        : info.hint !== null
          ? strings.harnessNotReady
          : null;
    return {
      id,
      name,
      models: unavailable === null ? (live?.models ?? info?.models ?? []) : [],
      model: live ? live.model : (info?.model ?? null),
      unavailable,
    };
  });
}
