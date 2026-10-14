/**
 * The agent tab's calls into `src-tauri/src/apps/agent_tab.rs`. Every shape
 * comes from `protocol.generated.ts`, which the Rust crate writes.
 */
import { invoke, on, KaavaRpcError } from "@openkaava/bridge";
import type { Attachment, Envelope, HarnessInfo } from "./protocol.generated";

/** Mirrors `apps::agent_tab::EVENT`. */
export const EVENT = "agent-tab:event";

/** Mirrors `apps::agent_tab::REFUSED`. */
export const REFUSED = -32010;

export interface Harnesses {
  harnesses: HarnessInfo[];
  /** Why this cluster cannot run an agent: a key of `strings.refusal`. */
  blocked: string | null;
}

export const harnesses = () => invoke<Harnesses>("agent-tab/harnesses");
export const attach = () => invoke<Attachment>("agent-tab/attach");
export const send = (text: string) => invoke<object>("agent-tab/send", { harness: "claude", text });
export const cancel = () => invoke<object>("agent-tab/cancel");
export const answer = (itemId: string, optionId: string) =>
  invoke<object>("agent-tab/answer", { itemId, optionId });
export const reset = () => invoke<object>("agent-tab/reset");

/** Every envelope the shell relays to this frame. */
export const onEnvelope = (cb: (envelope: Envelope) => void) =>
  on(EVENT, (payload) => cb(payload as Envelope));

/** A refusal's `data`: which refusal, and the hint that explains it. */
export interface Refusal {
  code: string;
  hint: string | null;
}

export function refusalOf(err: unknown): Refusal | null {
  if (!(err instanceof KaavaRpcError) || err.code !== REFUSED) return null;
  const data = err.data as Partial<Refusal> | undefined;
  return typeof data?.code === "string"
    ? { code: data.code, hint: typeof data.hint === "string" ? data.hint : null }
    : null;
}
