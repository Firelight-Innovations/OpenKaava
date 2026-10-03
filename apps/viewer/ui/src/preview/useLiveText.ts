/**
 * The text a preview should be drawing, kept current as it is edited.
 *
 * The source of truth is the Monaco model, not the file: a preview of a buffer
 * with unsaved edits should show the edits, and that is the whole point of
 * previewing while typing. Two places can hold the model — the live editor, when
 * the source is on screen beside the preview, and `documents`, when the editor
 * has been unmounted for a full-pane preview but the buffer is kept. Only when
 * neither exists (a fresh open straight into a preview) is the file read.
 *
 * Changes are debounced. A keystroke re-parses the Markdown and may re-render
 * diagrams, and doing that per character is work nobody sees.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { describe, readText } from "../rpc";
import { activeEditor, subscribeActiveEditor } from "../viewer/activeEditor";
import { documents } from "../tabs/useOpenFiles";

export const PREVIEW_DEBOUNCE_MS = 200;

export type LiveText =
  | { status: "loading" }
  | { status: "ready"; text: string; truncated: boolean }
  | { status: "failed"; message: string };

export function useLiveText(path: string): LiveText {
  const editor = useSyncExternalStore(subscribeActiveEditor, activeEditor);
  const model = editor?.getModel() ?? documents.get(path)?.model ?? null;

  const [state, setState] = useState<LiveText>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    if (model) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const truncated = (documents.get(path)?.truncatedAt ?? null) !== null;
      const publish = () => {
        if (!cancelled) setState({ status: "ready", text: model.getValue(), truncated });
      };
      // The first paint is not debounced: a toggle should show the document now.
      publish();
      const subscription = model.onDidChangeContent(() => {
        clearTimeout(timer);
        timer = setTimeout(publish, PREVIEW_DEBOUNCE_MS);
      });
      return () => {
        cancelled = true;
        clearTimeout(timer);
        subscription.dispose();
      };
    }

    void readText(path)
      .then((result) => {
        if (!cancelled) {
          setState({ status: "ready", text: result.text, truncated: result.truncated });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "failed", message: describe("files/read", err) });
      });
    return () => {
      cancelled = true;
    };
  }, [path, model]);

  return state;
}
