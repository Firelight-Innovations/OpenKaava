import { useEffect, useRef } from "react";
import { reportFocus } from "../bindings";
import { isTauri } from "./hostWindow";
import { createFocusReporter, readFocus, type FocusReporter } from "./focusReport";

/**
 * Report this window's focus to the backend, so `kaava-workspace` can tell a
 * subscribed agent when it moves. See `focusReport.ts` for the rules; this is
 * only the wiring to the events that can change the answer.
 *
 * `focusin`/`focusout` are captured on the document because they do not bubble
 * from every target otherwise, and window `focus`/`blur` cover the window
 * itself gaining or losing the OS foreground. The pane and cluster are the
 * shell's own state, so a change in either schedules a reading too.
 */
export function useFocusReporter(label: string, cluster: string | null, pane: string | null): void {
  const context = useRef({ window: label, cluster, pane });
  const reporter = useRef<FocusReporter | null>(null);

  useEffect(() => {
    // A browser tab on the dev server has no backend to tell.
    if (!isTauri()) return;

    const made = createFocusReporter(
      () => readFocus(document, context.current),
      (report) => {
        // A failed report only means the agent is not told this once; the next
        // change sends a fresh one.
        void reportFocus(report).catch(() => {});
      },
    );
    reporter.current = made;

    const onChange = () => made.schedule();
    document.addEventListener("focusin", onChange, true);
    document.addEventListener("focusout", onChange, true);
    globalThis.addEventListener("focus", onChange);
    globalThis.addEventListener("blur", onChange);
    made.schedule();

    return () => {
      document.removeEventListener("focusin", onChange, true);
      document.removeEventListener("focusout", onChange, true);
      globalThis.removeEventListener("focus", onChange);
      globalThis.removeEventListener("blur", onChange);
      made.dispose();
      reporter.current = null;
    };
  }, []);

  useEffect(() => {
    context.current = { window: label, cluster, pane };
    reporter.current?.schedule();
  }, [label, cluster, pane]);
}
