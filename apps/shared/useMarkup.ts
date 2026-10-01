/**
 * The kept markup of whatever a viewer is showing (a Godot scene, a `.blend`),
 * and what happens when one is drawn: it is kept on disk first, so a failed
 * send never loses it, then sent at once only if the person turned that on. The
 * Send markup button and the one-time offer to make sending automatic live
 * here too, so both viewers behave the same; a viewer supplies only how a
 * markup is saved and loaded, and which {@link MarkupTarget} it sends as.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isMarkupJson, type MarkupJson } from "@kaava/markup";
import type { MarkupExport } from "@kaava/markup/layer";
import {
  AUTO_SEND_KEY,
  TIP_KEY,
  afterDone,
  base64Blob,
  offerAutomatic,
  readPrefs,
  sendMarkup,
  setPref,
  type MarkupTarget,
} from "./markupFlow";

/**
 * The latest markup on this subject: just drawn, or read back from where it was
 * kept (`fresh` false). The URL is for the thumbnail and the larger view.
 */
export interface KeptMarkup {
  png: Blob;
  json: MarkupJson;
  url: string;
  savedAt: number | null;
  fresh: boolean;
}

/** What `*-viewer/markup` answers with. */
export interface SavedMarkup {
  png: string;
  json: string;
  savedAt: number;
}

export interface UseMarkupOptions {
  target: MarkupTarget;
  /** What the markup is of (a scene path, a `.blend`); `null` when nothing is chosen. */
  subject: string | null;
  /** Off while the viewer shows something markup does not apply to. */
  enabled: boolean;
  load: (subject: string) => Promise<SavedMarkup | null>;
  save: (subject: string, png: Blob, json: MarkupJson) => Promise<unknown>;
  /** The viewer's `useSendAction` send, so the "Sent" flash is shared. */
  send: (id: string, what: string, put: () => Promise<unknown>) => Promise<void>;
  onProblem: (message: string) => void;
  describeError: (err: unknown) => string;
}

export function useMarkup(opts: UseMarkupOptions) {
  const { target, subject, enabled, load, save, send, onProblem, describeError } = opts;
  const [markup, setMarkup] = useState<KeptMarkup | null>(null);
  const [barOpen, setBarOpen] = useState(true);
  const [previousOpen, setPreviousOpen] = useState(false);
  const [tip, setTip] = useState(false);
  // The offer to make sending automatic shows once per session however it is closed.
  const tipShown = useRef(false);

  // The thumbnail's URL is released when it is replaced or the pane goes.
  useEffect(() => {
    const url = markup?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [markup?.url]);

  // Each subject has its own last markup, kept on disk; bring it back when the
  // subject is shown so it can be looked at or sent without drawing it again.
  useEffect(() => {
    setMarkup(null);
    setPreviousOpen(false);
    if (!subject || !enabled) return;
    let live = true;
    load(subject)
      .then((saved) => {
        if (!live || !saved) return;
        const json: unknown = JSON.parse(saved.json);
        if (!isMarkupJson(json)) return;
        const png = base64Blob(saved.png);
        setMarkup(
          (now) =>
            now ?? {
              png,
              json,
              url: URL.createObjectURL(png),
              savedAt: saved.savedAt,
              fresh: false,
            },
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // `load` is a viewer's stable rpc wrapper; re-running on its identity would reload on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject, enabled]);

  const onMarkup = useCallback(
    (result: MarkupExport) => {
      setMarkup({
        png: result.png,
        json: result.json,
        url: URL.createObjectURL(result.png),
        savedAt: Date.now(),
        fresh: true,
      });
      setBarOpen(true);
      if (subject) {
        save(subject, result.png, result.json).catch((e: unknown) =>
          onProblem(`Couldn't keep the markup: ${describeError(e)}`),
        );
      }
      void readPrefs().then((prefs) => {
        if (afterDone(prefs) === "send") {
          void send("markup", "markup", () => sendMarkup(target, result.png, result.json, subject));
        }
      });
    },
    [subject, save, send, onProblem, describeError, target],
  );

  // The Send markup button. The first time it is pressed by hand, offer to make it automatic.
  const sendKept = useCallback(async () => {
    if (!markup) return;
    let ok = false;
    await send("markup", "markup", async () => {
      const item = await sendMarkup(target, markup.png, markup.json, subject);
      ok = true;
      return item;
    });
    if (!ok) return;
    const prefs = await readPrefs();
    if (offerAutomatic(prefs, tipShown.current)) {
      tipShown.current = true;
      setTip(true);
    }
  }, [markup, send, target, subject]);

  const flip = useCallback(
    (key: typeof AUTO_SEND_KEY | typeof TIP_KEY, value: boolean) => {
      setTip(false);
      setPref(key, value).catch((e: unknown) =>
        onProblem(`Couldn't change that setting: ${describeError(e)}`),
      );
    },
    [onProblem, describeError],
  );

  return {
    markup,
    barOpen,
    setBarOpen,
    previousOpen,
    setPreviousOpen,
    tip,
    closeTip: () => setTip(false),
    onMarkup,
    sendKept,
    flip,
  };
}
