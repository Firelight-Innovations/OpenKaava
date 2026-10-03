/**
 * What happens after something is dropped on, or pasted into, a terminal.
 *
 * The work is Rust's: it stores the bytes, knows which harness is running, and
 * writes the reference at the prompt. This module is the frontend's half of the
 * conversation — get the bytes across once, then say in words what happened,
 * because a drop has no other confirmation. The text appears at the prompt or it
 * does not, and "nothing appeared" is otherwise indistinguishable from "nothing
 * was asked".
 */
import {
  terminalDropPaths,
  terminalInsertItems,
  terminalPasteImage,
  type ContextInserted,
  type Harness,
} from "../bindings";
import { requestHarnessRefresh } from "./harnessRefresh";
import { notify } from "./terminalNotice";

/** How each harness is named to a person. */
export const HARNESS_LABEL: Record<Harness, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  shell: "shell",
};

/** One sentence for what an insertion did, or `null` when there is nothing to say. */
export function describe(result: ContextInserted): { text: string; error: boolean } | null {
  if (result.refused.length > 0) {
    return { text: result.refused.join(" "), error: true };
  }
  const { count } = result;
  if (count === 0) return null;
  const noun = count === 1 ? "reference" : "references";
  return {
    text:
      result.harness === "shell"
        ? `Inserted ${count} ${count === 1 ? "path" : "paths"}`
        : `Inserted ${count} ${noun} for ${HARNESS_LABEL[result.harness]}`,
    error: false,
  };
}

function report(id: string, result: ContextInserted): void {
  const said = describe(result);
  if (said) notify(id, said.text, said.error);
  // An insert is a moment the strip's "Insert as" label should be right.
  requestHarnessRefresh(id);
}

function failed(id: string, what: string, e: unknown): void {
  console.error(`kaava: ${what} into ${id} failed`, e);
  notify(id, `Could not ${what}`, true);
}

/** Standard base64 of a file's bytes, in slices so a large image does not blow
 *  the argument limit of `String.fromCharCode`. */
export async function fileToBase64(file: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const slice = 0x8000;
  for (let i = 0; i < bytes.length; i += slice) {
    binary += String.fromCharCode(...bytes.subarray(i, i + slice));
  }
  return btoa(binary);
}

/** `Ctrl+V` with an image on the clipboard. */
export async function pasteImage(
  id: string,
  file: { arrayBuffer(): Promise<ArrayBuffer>; name?: string },
): Promise<void> {
  try {
    const bytes = await fileToBase64(file);
    // A screenshot from the clipboard is named "image.png" by the webview, which
    // makes for a useless title; let Rust name it by its kind instead.
    const name = file.name && file.name !== "image.png" ? file.name : undefined;
    report(id, await terminalPasteImage(id, bytes, name));
  } catch (e) {
    failed(id, "paste that image", e);
  }
}

/** Files dropped on a terminal. Never rejects. */
export async function dropPaths(id: string, paths: string[]): Promise<void> {
  try {
    report(id, await terminalDropPaths(id, paths));
  } catch (e) {
    failed(id, `insert ${paths.length} path(s)`, e);
  }
}

/** The strip's re-insert. */
export async function insertItems(id: string, itemIds: string[]): Promise<void> {
  try {
    report(id, await terminalInsertItems(id, itemIds));
  } catch (e) {
    failed(id, "insert that item", e);
  }
}
