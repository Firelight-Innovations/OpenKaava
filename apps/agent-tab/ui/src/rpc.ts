/**
 * The agent tab's calls into `src-tauri/src/apps/agent_tab.rs`. Every shape
 * comes from `protocol.generated.ts`, which the Rust crate writes.
 */
import { invoke, on, KaavaRpcError } from "@openkaava/bridge";
import type { Attachment, Envelope, Harness, HarnessInfo } from "./protocol.generated";
import type { MentionHit } from "./mentions";

/** Mirrors `apps::agent_tab::EVENT`. */
export const EVENT = "agent-tab:event";

/** Mirrors `apps::agent_tab::REFUSED`. */
export const REFUSED = -32010;

export interface Harnesses {
  harnesses: HarnessInfo[];
  /** The harness this tab's next prompt goes to. */
  current: Harness;
  /** The harness this tab's agent runs, while it lives. */
  running: Harness | null;
  /** The name of the model that agent runs, once it has said. */
  model: string | null;
  /** Why this cluster cannot run an agent: a key of `strings.refusal`. */
  blocked: string | null;
}

export const harnesses = () => invoke<Harnesses>("agent-tab/harnesses");
export const attach = () => invoke<Attachment>("agent-tab/attach");
export interface SavedSession {
  id: string;
  title: string;
  updated: number;
  harness: Harness;
  archived: boolean;
}
export const history = () => invoke<{ sessions: SavedSession[] }>("agent-tab/history");
export const saveHistory = () => invoke<object>("agent-tab/history-save");
export const openHistory = (id: string, harness?: Harness) =>
  invoke<Attachment>("agent-tab/history-open", { id, ...(harness ? { harness } : {}) });
export const archiveHistory = (id: string, archived: boolean) =>
  invoke<object>("agent-tab/history-archive", { id, archived });
/** Sends to the tab's current harness: the running agent's, else the one chosen. */
export const send = (
  text: string,
  preferences?: { effort: string | null; ultracode: boolean; mode?: string },
) => invoke<object>("agent-tab/send", preferences ? { text, ...preferences } : { text });
export const searchContext = (query: string, kinds?: string[]) =>
  invoke<{ items: MentionHit[] }>("refs/search", { query, kinds, limit: 50 });
export const contextSources = () =>
  invoke<{ clusters: Array<{ id: string; title: string }>; issues: MentionHit[] }>(
    "agent-tab/context-sources",
  );
export const clusterContext = (clusterId: string) =>
  invoke<MentionHit>("agent-tab/cluster-context", { clusterId });
export const cliCommand = (text: string) => invoke<object>("agent-tab/cli-command", { text });
export const btwSend = (text: string, context: string) =>
  invoke<object>("agent-tab/btw-send", { text, context });
export const btwAttach = () => invoke<Attachment>("agent-tab/btw-attach");
export const btwCancel = () => invoke<object>("agent-tab/btw-cancel");
export const btwReset = () => invoke<object>("agent-tab/btw-reset");
export const btwAnswer = (itemId: string, optionId: string) =>
  invoke<object>("agent-tab/btw-answer", { itemId, optionId });
/**
 * Picks the harness for the tab's next session, and its model: a model's
 * value, `null` for the agent's default, or left out to keep the model this
 * tab chose for that harness before.
 */
export const choose = (harness: Harness, model?: string | null) =>
  invoke<object>("agent-tab/choose", model === undefined ? { harness } : { harness, model });
export const cancel = () => invoke<object>("agent-tab/cancel");
export const answer = (itemId: string, optionId: string) =>
  invoke<object>("agent-tab/answer", { itemId, optionId });
export const reset = () => invoke<object>("agent-tab/reset");
/** Starts the harness's own sign-in in the browser; `onLogin` hears how it ended. */
export const login = () => invoke<object>("agent-tab/login");
/**
 * Queues the change and answers with its number. The first status whose
 * `answered` reaches that number shows what the agent chose.
 */
export const setMode = (modeId: string) =>
  invoke<{ ticket: number }>("agent-tab/set-mode", { modeId }).then((r) => r.ticket);
/** Sets one of the agent's other options, such as its model; numbered as `setMode` is. */
export const setConfig = (configId: string, value: string) =>
  invoke<{ ticket: number }>("agent-tab/set-config", { configId, value }).then((r) => r.ticket);

/** Every envelope the shell relays to this frame. */
export const onEnvelope = (cb: (envelope: Envelope) => void) =>
  on(EVENT, (payload) => cb(payload as Envelope));

/** Mirrors `apps::agent_tab::CHOSEN`. */
export const CHOSEN = "agent-tab:chosen";

/** This tab's choice of harness and model, whether made here or in the agent bar. */
export const onChosen = (cb: (harness: Harness, model: string | null) => void) =>
  on(CHOSEN, (payload) => {
    const { harness, model } = payload as { harness: Harness; model?: string | null };
    cb(harness, model ?? null);
  });

/** Mirrors `apps::agent_tab::MODELS`. */
export const MODELS = "agent-tab:models";

/** A harness's agent has said which models it offers: `harnesses` now lists them. */
export const onModels = (cb: () => void) => on(MODELS, () => cb());

/** Mirrors `apps::agent_tab::LOGIN`. */
export const LOGIN = "agent-tab:login";

/** The sign-in this tab started has ended, signed in or not. */
export const onLogin = (cb: (harness: Harness, ok: boolean) => void) =>
  on(LOGIN, (payload) => {
    const { harness, ok } = payload as { harness: Harness; ok: boolean };
    cb(harness, ok);
  });

/** A refusal's `data`: which refusal, and the hint that explains it. */
export interface Refusal {
  code: string;
  hint: string | null;
}

/**
 * Mirrors `apps::READ_ONLY`. The shell refuses a write on a main checkout
 * before the agent tab's own code runs, with this code and no `data`, so the
 * tab names it for what it is rather than "Could not send that."
 */
export const READ_ONLY = -32003;

export function refusalOf(err: unknown): Refusal | null {
  if (err instanceof KaavaRpcError && err.code === READ_ONLY) {
    return { code: "mainCheckout", hint: null };
  }
  if (!(err instanceof KaavaRpcError) || err.code !== REFUSED) return null;
  const data = err.data as Partial<Refusal> | undefined;
  return typeof data?.code === "string"
    ? { code: data.code, hint: typeof data.hint === "string" ? data.hint : null }
    : null;
}
