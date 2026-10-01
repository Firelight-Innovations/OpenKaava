import type { SearchEventPayload } from "@openkaava/bridge/protocol";
import { claimTitlebarSearch } from "../titlebarSearch";

/**
 * App frames claiming the title bar's search field (`kaava/search-claim`).
 *
 * A frame's request is recorded whether or not the frame is showing, and
 * only installed in the shell's claim stack while the frame is an active
 * surface. That is what keeps a hidden tab or an unfocused pane from holding
 * the field, and it means a frame never has to track focus itself: it claims
 * when its filter exists, and the shell shows it when its pane is the one the
 * user is in. Several active frames resolve by the stack's own rule, most
 * recently installed wins.
 */
export interface FrameSearch {
  /** A frame's `kaava/search-claim`. Repeating it updates the claim. */
  claim(instanceId: string, params: unknown): boolean;
  /** A frame's `kaava/search-release`, or the frame going away. */
  release(instanceId: string): void;
  /** Which instances are active surfaces right now. */
  setActive(instanceIds: readonly string[]): void;
}

interface Wanted {
  placeholder: string;
  value: string;
}

type Handle = ReturnType<typeof claimTitlebarSearch>;

/** The placeholder and text off a `kaava/search-claim`, or null if malformed. */
export function declaredSearchClaim(params: unknown): Wanted | null {
  if (typeof params !== "object" || params === null) return null;
  const { placeholder, value } = params as { placeholder?: unknown; value?: unknown };
  if (typeof placeholder !== "string" || placeholder.trim() === "") return null;
  return { placeholder, value: typeof value === "string" ? value : "" };
}

export function createFrameSearch(
  deliver: (instanceId: string, payload: SearchEventPayload) => void,
): FrameSearch {
  const wanted = new Map<string, Wanted>();
  const installed = new Map<string, Handle>();
  let active = new Set<string>();

  const claimFor = (instanceId: string) => {
    const want = wanted.get(instanceId);
    return {
      placeholder: want?.placeholder ?? "",
      value: want?.value ?? "",
      onChange: (value: string) => {
        const held = wanted.get(instanceId);
        if (!held) return;
        held.value = value;
        installed.get(instanceId)?.update(claimFor(instanceId));
        deliver(instanceId, { kind: "query", value });
      },
      onSubmit: () =>
        deliver(instanceId, { kind: "submit", value: wanted.get(instanceId)?.value ?? "" }),
      onEscape: () =>
        deliver(instanceId, { kind: "escape", value: wanted.get(instanceId)?.value ?? "" }),
    };
  };

  function sync(): void {
    for (const [id, handle] of installed) {
      if (!wanted.has(id) || !active.has(id)) {
        handle.release();
        installed.delete(id);
      }
    }
    for (const id of wanted.keys()) {
      const existing = installed.get(id);
      if (existing) existing.update(claimFor(id));
      else if (active.has(id)) installed.set(id, claimTitlebarSearch(claimFor(id)));
    }
  }

  return {
    claim(instanceId, params) {
      const next = declaredSearchClaim(params);
      if (next === null) return false;
      wanted.set(instanceId, next);
      sync();
      return true;
    },
    release(instanceId) {
      wanted.delete(instanceId);
      sync();
    },
    setActive(instanceIds) {
      active = new Set(instanceIds);
      sync();
    },
  };
}
