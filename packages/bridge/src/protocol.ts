/**
 * Wire types for transport B — tool frontend <-> shell window messages.
 * Mirrors `docs/tool-protocol.md` §3 exactly; if this drifts from that file,
 * the doc wins.
 *
 * Every message carries `kaava: 1`. It's a version marker, but its real job
 * is cheaper: an iframe's `window` can receive `message` events from
 * anything, not just its host (browser extensions, embedded widgets, the
 * page's own code posting to itself) — `kaava === 1` is what lets the bridge
 * ignore all of that in one check instead of trying to prove a message is
 * safe to parse.
 */

/** Mirrors the `Session` shape shared with the tool core's `kaava/hello`. */
export interface Session {
  /** Root of the open project. Null until projects exist. */
  projectPath: string | null;
}

export interface KaavaErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

// ---- Frontend -> shell ----

export interface HelloMessage {
  kaava: 1;
  kind: "hello";
}

export interface RequestMessage {
  kaava: 1;
  kind: "request";
  id: number;
  method: string;
  params?: unknown;
}

export type OutgoingMessage = HelloMessage | RequestMessage;

// ---- Shell -> frontend ----

export interface ReadyMessage {
  kaava: 1;
  kind: "ready";
  toolId: string;
  protocol: 1;
  session: Session;
}

export interface ResponseMessage {
  kaava: 1;
  kind: "response";
  id: number;
  result?: unknown;
  error?: KaavaErrorPayload;
}

export interface EventMessage {
  kaava: 1;
  kind: "event";
  event: string;
  payload: unknown;
}

/**
 * A menu command, aimed at whichever frame the shell considers active.
 *
 * Distinct from `event` rather than an event with a reserved name, because the
 * two make opposite claims. An event is news — the shell relaying something
 * that happened, which a frame may ignore. A command is an *instruction* the
 * user just gave through the shell's own chrome, and the shell only sends one
 * the frame has said it can carry out (see `kaava/commands`). Keeping them
 * apart is what lets a frontend register a handler for one without having to
 * filter the other out of the same stream.
 *
 * Fire-and-forget: there is no id and no reply. What the menu needed to know —
 * whether this command is possible at all — was answered before the item was
 * ever clickable, and a result arriving afterwards would have nowhere to go,
 * since the menu has closed by then.
 */
export interface CommandMessage {
  kaava: 1;
  kind: "command";
  command: string;
}

export type IncomingMessage = ReadyMessage | ResponseMessage | EventMessage | CommandMessage;

// ---- The sideways channel: frame -> shell -> another frame ----

/**
 * The event name a `kaava/open` is delivered under.
 *
 * One name for every kind of open, rather than a name per intent, because the
 * shell must not learn what any of them mean. What is being asked for lives in
 * the payload and is read by the app that receives it: File Explorer sends
 * `{path, preview}` and File Viewer knows that is a file to show; the source
 * control view will send something else to the same app under the same event.
 * A shell that routed on intent would need a table of every app's verbs, which
 * is the thing `kaava/commands` was shaped to avoid.
 */
export const OPENED_EVENT = "kaava:opened";

/**
 * The event prefix a published topic is delivered under.
 *
 * Prefixed rather than posted as the bare topic name, so an app's topics can
 * never collide with the shell's own push events (`project:changed`,
 * `files:open-path`). A frame subscribing to `files/active-path` is listening
 * on `kaava:topic/files/active-path`, and nothing an app can publish is able to
 * impersonate news the shell authored.
 */
export const TOPIC_EVENT_PREFIX = "kaava:topic/";

/**
 * The event `kaava:theme-changed` is delivered under — the shell telling
 * every app frame the resolved theme and chosen accent, live. A colon rather
 * than `TOPIC_EVENT_PREFIX`'s slash-bearing form, like `OPENED_EVENT` above,
 * because this is shell-authored news broadcast to every app frame, not one
 * app publishing to its cluster-mates. See `packages/bridge/src/theme.ts` for
 * the app-side half and `src/shell/themeBroadcast.ts` for the shell-side one.
 */
export const THEME_CHANGED_EVENT = "kaava:theme-changed";

/**
 * What arrives with a `kaava:theme-changed` event. Mirrors
 * `src/shell/themeBroadcast.ts`'s `ThemeChangedPayload` as a separate
 * declaration rather than an import, the same as `Session` above — the shell
 * and an app frame are different builds, and this package is the one place
 * both agree on the wire shape.
 */
export interface ThemeChangedPayload {
  /** The resolved theme actually applied. Never "system" — that is a
   *  setting, resolved to one of these two before this is sent. */
  theme: "dark" | "light";
  /** One of the five options `docs/design/kaava-ds/tokens.json` defines. */
  accent: "amber" | "blue" | "green" | "violet" | "coral";
}

/** What arrives with a `kaava:topic/*` event. */
export interface PublishedTopic {
  value: unknown;
  /**
   * The instance that published it.
   *
   * Carried because a subscriber may have several publishers — two Viewers in
   * one cluster both publish an active path — and "which one" is a question
   * only the subscriber can answer, since only it knows whether it cares. The
   * shell does not arbitrate; it delivers both.
   */
  from: string;
}

/**
 * The one check every inbound `message` event must pass before anything
 * else looks at it. Deliberately loose beyond that — `kind`-specific shape
 * is trusted once this and the `kind` narrow it, since the shell is the only
 * thing this bridge accepts messages from at all (see the `event.source`
 * check in `client.ts`).
 */
export function isKaavaMessage(data: unknown): data is IncomingMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kaava?: unknown }).kaava === 1 &&
    typeof (data as { kind?: unknown }).kind === "string"
  );
}

export function isReadyMessage(msg: IncomingMessage): msg is ReadyMessage {
  return msg.kind === "ready";
}

export function isResponseMessage(msg: IncomingMessage): msg is ResponseMessage {
  return msg.kind === "response";
}

export function isEventMessage(msg: IncomingMessage): msg is EventMessage {
  return msg.kind === "event";
}

export function isCommandMessage(msg: IncomingMessage): msg is CommandMessage {
  return msg.kind === "command" && typeof (msg as CommandMessage).command === "string";
}
