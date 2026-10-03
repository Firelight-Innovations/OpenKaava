/**
 * The frame side of the title bar's shared search field.
 *
 * A frame claims the field with `kaava/search-claim` and gives it up with
 * `kaava/search-release`; what the user types, submits or escapes in the field
 * comes back as `kaava:search` events. The shell decides whether the claim is
 * showing (only the active surface's is), so a frame claims when its filter
 * exists and releases when it does not, and never has to track focus.
 *
 * A frame holds one claim. Claiming again replaces the previous handle, which
 * goes quiet without sending a release, so the shell sees one continuous claim.
 */
import { SEARCH_EVENT, type SearchClaimParams, type SearchEventPayload } from "./protocol.js";

export interface SearchClaim {
  placeholder: string;
  value: string;
  /** The user typed in the field. `value` is its whole text. */
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onEscape?: (value: string) => void;
}

export interface SearchHandle {
  /** Change the placeholder, the value, or the handlers. Unchanged text sends nothing. */
  update(next: Partial<SearchClaim>): void;
  release(): void;
}

export interface SearchIo {
  invoke(method: string, params?: unknown): Promise<unknown>;
  on(event: string, cb: (payload: unknown) => void): () => void;
}

function asSearchEvent(payload: unknown): SearchEventPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { kind, value } = payload as { kind?: unknown; value?: unknown };
  if (kind !== "query" && kind !== "submit" && kind !== "escape") return null;
  return { kind, value: typeof value === "string" ? value : "" };
}

export function createSearchClaimer(io: SearchIo): (initial: SearchClaim) => SearchHandle {
  let current: { release: (send: boolean) => void } | null = null;

  return function claimSearch(initial: SearchClaim): SearchHandle {
    current?.release(false);

    let claim = initial;
    let sent: SearchClaimParams | null = null;
    let live = true;

    // Fire-and-forget, and swallowed: a standalone host refuses the method, and
    // nothing in the frame depends on the answer. See `claimSearch`'s caller for
    // the local-input fallback.
    const send = () => {
      if (!live) return;
      const params = { placeholder: claim.placeholder, value: claim.value };
      if (sent && sent.placeholder === params.placeholder && sent.value === params.value) return;
      sent = params;
      void io.invoke("kaava/search-claim", params).catch(() => {});
    };

    const off = io.on(SEARCH_EVENT, (payload) => {
      const event = asSearchEvent(payload);
      if (!live || event === null) return;
      if (event.kind === "query") {
        // The shell already holds this text, so it must not be echoed back.
        claim = { ...claim, value: event.value };
        sent = { placeholder: claim.placeholder, value: event.value };
        claim.onChange(event.value);
      } else if (event.kind === "submit") {
        claim.onSubmit?.(event.value);
      } else {
        claim.onEscape?.(event.value);
      }
    });

    const release = (sendRelease: boolean) => {
      if (!live) return;
      live = false;
      off();
      if (current?.release === release) current = null;
      if (sendRelease) void io.invoke("kaava/search-release").catch(() => {});
    };

    const handle: SearchHandle = {
      update(next) {
        if (!live) return;
        claim = { ...claim, ...next };
        send();
      },
      release: () => release(true),
    };
    current = { release };
    send();
    return handle;
  };
}
