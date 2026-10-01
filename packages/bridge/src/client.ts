/**
 * The testable core of the bridge. `createClient` takes its window handles
 * as parameters instead of reaching for `window`/`window.parent` globally —
 * under jsdom `window.parent === window`, so a client hard-wired to globals
 * could only ever be exercised on the Tauri path. Passing `self`/`parent` in
 * lets tests fake the iframe relationship and drive the Kaava path too.
 * `src/index.ts` is the thin layer that supplies the real globals.
 */
import {
  isCommandMessage,
  isEventMessage,
  isKaavaMessage,
  isReadyMessage,
  isResponseMessage,
  TOPIC_EVENT_PREFIX,
  type KaavaErrorPayload,
  type IncomingMessage,
  type PublishedTopic,
  type Session,
} from "./protocol.js";
import { KaavaErrorCode, KaavaRpcError } from "./errors.js";
import { createSearchClaimer, type SearchClaim, type SearchHandle } from "./search.js";

export type { SearchClaim, SearchHandle };

const DEFAULT_TIMEOUT_MS = 30_000;

export type Host = "kaava" | "tauri";

/** A window-shaped message event — kept minimal (not the DOM `MessageEvent`
 * type) so tests can hand the listener plain objects instead of constructing
 * real ones. */
export interface IncomingWindowMessage {
  source: unknown;
  origin: string;
  data: unknown;
}

/** The slice of `Window` the bridge needs, on both sides of the postMessage
 * call. `self` also needs to listen; `parent` only ever gets posted to. */
export interface WindowLike {
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: "message", listener: (event: IncomingWindowMessage) => void): void;
}

/** The two Tauri APIs the bridge needs, reshaped to hide the difference
 * between a raw `invoke` and a `listen` that hands back a full `Event<T>`. */
export interface TauriCore {
  invoke(cmd: string, args?: unknown): Promise<unknown>;
  listen(event: string, cb: (payload: unknown) => void): Promise<() => void>;
}

export interface ClientOptions {
  self: WindowLike;
  parent: WindowLike;
  /**
   * Dynamic import of the Tauri APIs, injected so `@tauri-apps/api` stays an
   * optional peer dependency — a tool that only ever runs inside OpenKaava
   * shouldn't have to install it — and so tests can supply a fake without
   * the real module needing to resolve at all.
   */
  importTauri?: () => Promise<TauriCore>;
  /** Default per-`invoke` timeout in ms. Overridable per call too. */
  timeoutMs?: number;
}

export interface Client {
  invoke<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
  /**
   * Run this when the shell's menu bar asks for a command. See
   * `declareCommands` for how the shell knows which ones to offer.
   */
  onCommand(cb: (command: string) => void): () => void;
  /**
   * Tell the shell which commands this frontend can carry out **right now**.
   *
   * The set is a fact about the current moment, not about the app: Save is
   * possible only while something is dirty, Undo only while an editor holds a
   * history. So this is called again whenever that changes, and the last call
   * wins — it replaces the declaration rather than adding to it.
   *
   * De-duplicated against the last set actually sent, because the natural place
   * to call it is a React effect that runs on every render.
   */
  declareCommands(commands: readonly string[]): void;
  /**
   * Ask the shell to put something on screen in a *different* app, in this
   * frame's own cluster — opening one if the cluster has none, and bringing it
   * forward if it does.
   *
   * The one way an app reaches sideways. It names the kind of app it wants and
   * hands over an opaque payload; it never names an instance, because which
   * instance is a fact about the layout that only the shell can see, and an app
   * that could address one by id could address one in someone else's cluster.
   *
   * Resolves with the instance the shell chose, for a caller that wants to know
   * whether it opened something new. Most callers ignore it.
   */
  openIn(appId: string, payload?: unknown): Promise<{ instanceId: string }>;
  /**
   * State a fact about this frame, for other apps in its cluster to read.
   *
   * The counterpart to `openIn`: that one is an instruction aimed at one app,
   * this is news any number of apps may care about, and neither publisher nor
   * subscriber learns the other exists. The Viewer publishes which file it is
   * showing; the Explorer highlights that row if it happens to be listening,
   * and nothing breaks in either app when the other is not open.
   *
   * The last value published under a topic is retained and replayed to frames
   * that mount later, so a subscriber is never left waiting for a change to
   * something that has already settled.
   *
   * De-duplicated against the last value sent for the same topic, because the
   * natural place to call it is a React effect that runs on every render.
   */
  publish(topic: string, value: unknown): void;
  /** Listen for what other frames in this cluster publish under `topic`. */
  subscribe(topic: string, cb: (value: unknown, from: string) => void): () => void;
  session(): Promise<Session>;
  host(): Host;
  /**
   * Claim the shell's title bar search field for this frame; see `search.ts`.
   * Refused under a standalone host, where the frame should draw its own input.
   */
  claimSearch(claim: SearchClaim): SearchHandle;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

async function defaultImportTauri(): Promise<TauriCore> {
  const [{ invoke }, { listen }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ]);
  return {
    invoke,
    listen: (event, cb) => listen(event, (e) => cb(e.payload)),
  };
}

export function createClient(opts: ClientOptions): Client {
  const { self, parent, timeoutMs: defaultTimeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const importTauri = opts.importTauri ?? defaultImportTauri;

  // Structural, not timed: a tool's own standalone Tauri app is always a
  // top-level window, so `self === parent` (mirroring `window.parent ===
  // window`) is a one-time fact about how the page was loaded, checked once
  // here — no probe, no timeout, no ambiguous middle state.
  const host: Host = self === parent ? "tauri" : "kaava";

  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const commandHandlers = new Set<(command: string) => void>();
  /** The last set handed to `declareCommands`, joined, for the dedupe there. */
  let declared: string | null = null;
  /** The last value published per topic, serialized, for the dedupe in `publish`. */
  const published = new Map<string, string>();

  // Set from the `ready` message's `event.origin` (see the listener below),
  // and used as the exact `targetOrigin` for every post after that. Null
  // until then, which is also the queue-vs-flush signal.
  let shellOrigin: string | null = null;
  let queued: Array<() => void> = [];
  let resolveSession!: (s: Session) => void;
  const sessionPromise = new Promise<Session>((resolve) => {
    resolveSession = resolve;
  });

  function settleResponse(id: number, result: unknown, error: KaavaErrorPayload | undefined) {
    const req = pending.get(id);
    if (!req) return; // already timed out, or an id this client never sent
    pending.delete(id);
    clearTimeout(req.timer);
    if (error) req.reject(new KaavaRpcError(error.code, error.message, error.data));
    else req.resolve(result);
  }

  if (host === "kaava") {
    self.addEventListener("message", (event) => {
      // Anything not from the parent frame, or not wearing the version
      // marker, isn't the shell — could be an unrelated message sharing the
      // window, or (before `ready` arrives) simply not it yet.
      if (event.source !== parent) return;
      if (!isKaavaMessage(event.data)) return;
      const msg: IncomingMessage = event.data;

      if (isReadyMessage(msg)) {
        if (shellOrigin !== null) return; // handshake only ever happens once
        shellOrigin = event.origin;
        resolveSession(msg.session);
        const flush = queued;
        queued = [];
        flush.forEach((fire) => fire());
        return;
      }
      if (isResponseMessage(msg)) {
        settleResponse(msg.id, msg.result, msg.error);
        return;
      }
      if (isEventMessage(msg)) {
        listeners.get(msg.event)?.forEach((cb) => cb(msg.payload));
        return;
      }
      if (isCommandMessage(msg)) {
        commandHandlers.forEach((cb) => cb(msg.command));
      }
    });

    // Sent with targetOrigin "*": the shell's origin isn't known until it
    // replies, and this message carries nothing worth protecting. The
    // client speaks first on purpose — waiting for the shell to announce
    // itself would race this frame's own script load and listener
    // registration, and a postMessage that arrives before a listener exists
    // is simply gone, no replay. (Same failure mode this project already
    // hit with Tauri events during splash boot — see Splash.tsx.)
    parent.postMessage({ kaava: 1, kind: "hello" }, "*");
  } else {
    // No shell exists under the Tauri host, so there's no handshake to wait
    // on — the session is knowable immediately, and is always empty.
    resolveSession({ projectPath: null });
  }

  function sendRequest(id: number, method: string, params: unknown) {
    // Every caller is either past the handshake or being flushed by it, so
    // this is always set. Throwing rather than falling back to "*" keeps that
    // an invariant: a future edit that reached here early would otherwise
    // broadcast a request — params and all — to any listening origin, and do
    // it silently.
    if (shellOrigin === null) throw new Error("bridge: sendRequest before handshake");
    parent.postMessage({ kaava: 1, kind: "request", id, method, params }, shellOrigin);
  }

  function invokeKaava<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new KaavaRpcError(KaavaErrorCode.Timeout, `invoke timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      // The `pending.has` guard matters for the queued path specifically. The
      // timeout above starts when `invoke` is called, not when the request is
      // actually posted, so a call made before the handshake can time out
      // while still sitting in the queue — and then get flushed to the shell
      // anyway once `ready` arrives. The caller has already seen a rejection
      // at that point, so for any method that mutates something, the shell
      // would be executing work its caller believes failed. Dropping the
      // fire-and-forget leftover is the whole fix.
      const fire = () => {
        if (pending.has(id)) sendRequest(id, method, params);
      };
      // Queued before handshake and flushed on `ready`, so tool code never
      // has to await anything before its first call.
      if (shellOrigin !== null) fire();
      else queued.push(fire);
    });
  }

  async function invokeTauri<T>(method: string, params: unknown): Promise<T> {
    // `/` isn't legal in a Tauri command name, so `kaava/*` would be a
    // guaranteed runtime error if forwarded. Handle the reserved methods
    // locally instead of ever reaching `@tauri-apps/api`. There's no real
    // handshake to answer under this host, so `hello` only has the one
    // field the bridge can honestly claim to know; `shutdown` has nothing
    // to ack and resolves to null, per the reserved-methods table in
    // docs/tool-protocol.md §2.
    if (method === "kaava/hello") return { protocol: 1 } as unknown as T;
    if (method === "kaava/shutdown") return null as unknown as T;
    // Nothing is waiting on this one here. Under the orchestrator it tells the
    // shell a frame has drawn its first meaningful content, which is what the
    // splash window holds for; a tool's own Tauri app has no splash and no
    // second window to reveal, so it acknowledges and does nothing, like
    // `kaava/shutdown` above.
    if (method === "kaava/painted") return null as unknown as T;
    // Nothing under this host has a menu bar to grey out — the tool's own Tauri
    // app draws its own chrome — so the declaration is accepted and dropped,
    // exactly like `kaava/painted` above. Refusing it instead would make every
    // frontend that supports menu commands log an error on a host where the
    // feature simply does not apply.
    if (method === "kaava/commands") return null as unknown as T;
    // The sideways channel needs a shell to be sideways *through*: `kaava/open`
    // finds another app in this frame's cluster, and `kaava/publish` relays to
    // the frames beside it. A tool's own Tauri app is one window with one
    // frontend in it — there is no cluster, no second app, and nobody to
    // deliver to.
    //
    // Refused rather than dropped, and that is the difference from
    // `kaava/commands` above. A dropped declaration costs nothing: the menu bar
    // it would have greyed out does not exist here either, so accepting it
    // silently is honest. An open is a user's instruction that something should
    // now be on screen, and answering "done" to that while nothing happened
    // would leave a frontend believing it had opened a file it had not.
    // `kaava/publish` is refused alongside it rather than dropped for a smaller
    // reason: it is fire-and-forget below, so the rejection is swallowed at the
    // call site, and having the two halves of one feature disagree about
    // whether this host supports it would be the confusing thing to read.
    // `kaava/drag` is refused with them, for `kaava/open`'s reason: a drag out of
    // a frame aims at somewhere else in the window, a standalone app has no
    // elsewhere, and the user is mid-gesture while it is answered.
    if (
      method === "kaava/open" ||
      method === "kaava/publish" ||
      method === "kaava/drag" ||
      method === "kaava/search-claim" ||
      method === "kaava/search-release"
    ) {
      throw new KaavaRpcError(
        KaavaErrorCode.MethodNotFound,
        `${method}: there is no shell here — this frontend is its own window`,
      );
    }
    if (method.startsWith("kaava/")) {
      throw new KaavaRpcError(KaavaErrorCode.MethodNotFound, `no such method: ${method}`);
    }
    const tauri = await importTauri();
    return tauri.invoke(method, params) as Promise<T>;
  }

  // Named rather than written straight into the object literal, because
  // `declareCommands` below calls it. `index.ts` exports every method of this
  // client *unbound* (`export const invoke = client.invoke`), so a `this.invoke`
  // there would be a `this` of undefined the moment anyone imported the
  // shorthand — which is every caller.
  function invokeAny<T>(
    method: string,
    params?: unknown,
    timeoutMs = defaultTimeoutMs,
  ): Promise<T> {
    return host === "kaava"
      ? invokeKaava<T>(method, params, timeoutMs)
      : invokeTauri<T>(method, params);
  }

  // Named for the same reason `invokeAny` is, and it is not a style choice:
  // `subscribe` below is a wrapper around this one, and `index.ts` exports
  // every method of this client *unbound*, so a `this.on` there would find a
  // `this` of undefined the moment anyone imported the shorthand.
  function onEvent(event: string, cb: (payload: unknown) => void): () => void {
    if (host === "kaava") {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
      return () => set.delete(cb);
    }

    // No shell to relay events under Tauri — a tool's own core pushes
    // notifications the same way the rest of this app's Rust side already
    // does (see bindings.ts / Splash.tsx), so `on` forwards to Tauri's
    // event system there instead. `listen` is itself async, but `on` must
    // return synchronously; `cancelled` covers the unsubscribe-before-
    // registration-resolves race the same way Splash.tsx's cleanup does.
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    importTauri()
      .then((tauri) => tauri.listen(event, cb))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => console.error(err));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }

  const claimSearch = createSearchClaimer({
    invoke: (method, params) => invokeAny(method, params),
    on: onEvent,
  });

  return {
    invoke: invokeAny,

    on: onEvent,

    onCommand(cb: (command: string) => void): () => void {
      // No registration with the host: `declareCommands` is what tells the
      // shell anything, and a frontend that listened without declaring would
      // simply never be sent a command. Under the Tauri host nothing ever
      // arrives at all, and the unsubscribe is still real so a component can
      // clean up without knowing which host it is on.
      commandHandlers.add(cb);
      return () => commandHandlers.delete(cb);
    },

    declareCommands(commands: readonly string[]): void {
      // Sorted before joining so that two orderings of the same set compare
      // equal — the caller assembles this from conditionals, and the order they
      // happen to fall in is not a change worth a round trip.
      const key = [...commands].sort().join(" ");
      if (key === declared) return;
      declared = key;
      // Fire-and-forget. A host that has no use for the declaration answers
      // null, and one that refuses has told us nothing we can act on — the
      // frontend's own state is unchanged either way. What must not happen is
      // an unhandled rejection from a call nobody awaited.
      void invokeAny("kaava/commands", { commands: [...commands] }).catch(() => {});
    },

    openIn(appId: string, payload?: unknown): Promise<{ instanceId: string }> {
      return invokeAny<{ instanceId: string }>("kaava/open", { appId, payload });
    },

    publish(topic: string, value: unknown): void {
      // Compared by serialization rather than by reference, for the same reason
      // `declareCommands` sorts before joining: the caller assembles this value
      // fresh on every render, so an identical one is a new object every time
      // and a reference check would send a message per keystroke.
      //
      // A value that will not serialize is treated as always-changed rather
      // than as an error. It cannot cross `postMessage` intact anyway, so the
      // send below is what should complain about it, not the dedupe.
      let key: string;
      try {
        key = JSON.stringify(value) ?? "undefined";
      } catch {
        key = ` unserializable:${published.size}`;
      }
      if (published.get(topic) === key) return;
      published.set(topic, key);
      // Fire-and-forget, like `declareCommands`, and swallowed for the same
      // reason: nothing in this frontend's own state depends on the answer, and
      // an unhandled rejection from a call nobody awaited is the worse outcome.
      // Under the Tauri host this rejects every time — see `invokeTauri`.
      void invokeAny("kaava/publish", { topic, value }).catch(() => {});
    },

    subscribe(topic: string, cb: (value: unknown, from: string) => void): () => void {
      // Straight through `on`, so a topic behaves exactly like any other event
      // this bridge delivers — including doing nothing at all under the Tauri
      // host, where nothing will ever publish. The prefix is applied here and
      // nowhere else, which is what keeps a topic from being able to name one
      // of the shell's own events.
      return onEvent(`${TOPIC_EVENT_PREFIX}${topic}`, (payload) => {
        const message = payload as PublishedTopic | null;
        if (typeof message !== "object" || message === null) return;
        cb(message.value, typeof message.from === "string" ? message.from : "");
      });
    },

    session(): Promise<Session> {
      return sessionPromise;
    },

    host(): Host {
      return host;
    },

    claimSearch,
  };
}
