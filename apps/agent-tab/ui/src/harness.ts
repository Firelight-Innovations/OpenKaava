/**
 * The tab's view of the harness registry: which harness a sentence is about,
 * the words for its hints, its picker's choices, and the model it runs.
 *
 * Everything here reads `agent-tab/harnesses` and the session's status. The
 * registry itself lives in Rust (`crates/kaava-agent-host/src/harness.rs`),
 * so a new harness shows up here with no change to this file.
 */
import type { Harness, HarnessInfo, Hint } from "./protocol.generated";
import { strings, type HarnessWords } from "./strings";

/** What `agent-tab/harnesses` says about `harness`, if the registry lists it. */
export function infoOf(infos: HarnessInfo[], harness: Harness | null): HarnessInfo | undefined {
  return infos.find((info) => info.harness === harness);
}

/**
 * `hint` as a sentence about `words`' harness, or a neutral one before the tab
 * knows which. A refusal's hint arrives untyped, so an unknown one is neutral too.
 */
export function hintText(hint: Hint, words: HarnessWords | undefined): string {
  const known = Object.prototype.hasOwnProperty.call(strings.hint, hint);
  const sentence = known ? strings.hint[hint] : undefined;
  return words && sentence ? sentence(words) : strings.hintUnknown;
}
