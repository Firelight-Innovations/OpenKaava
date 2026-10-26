/**
 * Every call this app makes to its host, in one file. The shapes mirror
 * `src-tauri/src/apps/design.rs` and are restated rather than imported, for the
 * reason `apps/files/ui/src/rpc.ts` gives.
 */
import { VeistraRpcError, invoke } from "@veistra/bridge";
import type { Comment } from "./comments";
import type { PickedElement } from "./probe";

/** A URL the backend has cleared for embedding. */
export interface Target {
  url: string;
  origin: string;
}

/** What `design/arm` hands back: the id that removes the probe again. */
export interface Armed {
  scriptId: string;
}

export interface Screenshot {
  /** `data:image/png;base64,…`, ready for an `<img>` or a clipboard write. */
  dataUrl: string;
  width: number;
  height: number;
}

/** Check an address and normalise it. **The frontend must never build an iframe
 *  `src` any other way**: what may be loaded has consequences past this app, so
 *  Rust decides, and a refusal's message is written to be shown verbatim. */
export const resolveTarget = (url: string) => invoke<Target>("design/target", { url });

/** Put the probe in front of every document the window loads from now on. Call
 *  it *before* pointing the frame anywhere — a document-created script reaches
 *  only documents created after it. `replaces` is dropped first. */
export const arm = (replaces: string | null) => invoke<Armed>("design/arm", { replaces });

/** Stop the next document getting a probe. Already-loaded frames keep theirs
 *  until they navigate — which is why the app also reloads the frame. */
export const disarm = (scriptId: string) => invoke<null>("design/disarm", { scriptId });

/** Photograph one rectangle of the window, in the top-level document's CSS
 *  pixels — which is what `absoluteRect` produces. */
export const capture = (rect: { x: number; y: number; width: number; height: number }) =>
  invoke<Screenshot>("design/capture", rect);

/** Every comment on this machine, oldest first. Unfiltered — the panel decides
 *  what order to draw them in and which ones to mark as being from elsewhere. */
export const listComments = () => invoke<Comment[]>("design/comment/list");

/** Leave a comment on what was just picked. The probe's payload goes through
 *  unchanged rather than being flattened here — `design.rs` maps the two shapes
 *  onto each other in one place. `shot` is the `dataUrl` from {@link capture},
 *  and null is honest: an element that could not be photographed is still worth
 *  commenting on. */
export const addComment = (picked: PickedElement, request: string, shot: string | null) =>
  invoke<Comment>("design/comment/add", { picked, request, shot });

/** Answer a question the agent asked, which hands the comment back to it. */
export const replyToComment = (id: string, text: string) =>
  invoke<Comment>("design/comment/reply", { id, text });

/** Close a comment yourself — because it is done, or because it no longer
 *  matters. The agent's own resolutions come in over MCP, not through here. */
export const resolveComment = (id: string, text: string) =>
  invoke<Comment>("design/comment/resolve", { id, text });

/** Forget a comment and its picture outright. */
export const deleteComment = (id: string) => invoke<null>("design/comment/delete", { id });

/** The host's own words for why a call failed. Every refusal in `design.rs` is
 *  written as a sentence for a person, so none is mapped to a category here. */
export function reasonFor(err: unknown): string {
  if (err instanceof VeistraRpcError) return err.message;
  return String(err);
}
