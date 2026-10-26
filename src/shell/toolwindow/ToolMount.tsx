import { useCallback, useEffect, useRef } from "react";
import type { ToolPresentation } from "../contract";
import { useToolFrontend } from "../state/toolFrontend";
import BootOverlay from "./BootOverlay";
import UnavailableState from "./UnavailableState";

/**
 * One instance's iframe, plus the boot overlay laid over it until the handshake
 * completes, or the unavailable state in place of an empty frame.
 *
 * Mounted once per *instance* id and kept mounted for that instance's whole
 * life. `ToolWindow` renders one of these per tab in the cluster and positions
 * them over their panes, so this never unmounts on a tab switch, a split, a
 * divider drag, or a tab being dragged into another pane. That is the property
 * the whole arrangement exists to protect: an iframe that remounts reloads the
 * app inside it, and a Files that forgot its open file every time you
 * rearranged the layout would make the layout not worth rearranging.
 *
 * `instanceId` and `tool.id` are not interchangeable, and keeping them apart is
 * the point; see each one's own doc below.
 */
export default function ToolMount({
  instanceId,
  tool,
  title,
  ready,
  registerFrame,
  unregisterFrame,
}: {
  /**
   * Identity — what a message from this frame resolves to, which tab to close,
   * whose title changed.
   */
  instanceId: string;
  /**
   * How to present the app this is an instance of. `tool.id` is the app id — a
   * *type*, which is what decides which code to load, so it is what
   * `useToolFrontend` resolves a URL from. Two Files instances ask for the same
   * URL and get two independent frames, which is exactly right: same code,
   * separate state.
   */
  tool: ToolPresentation;
  /** This instance's own tab title, which the boot overlay names. */
  title: string;
  /** Whether this instance's hello/ready handshake has completed. */
  ready: boolean;
  /**
   * Both ids travel with the registration rather than being looked up later.
   * The instance id is what a message resolves to; the app id is where its
   * `invoke` is routed and what `veistra/painted` reports. Establishing identity
   * and routing in one call means there is no second lookup to disagree with
   * the first.
   */
  registerFrame: (instanceId: string, appId: string, isApp: boolean, win: Window) => void;
  unregisterFrame: (win: Window) => void;
}) {
  const frontend = useToolFrontend(tool.id);
  const windowRef = useRef<Window | null>(null);

  // `useCallback` keyed on stable deps so the ref callback's identity never
  // changes across re-renders — an inline arrow here would make React detach
  // and reattach the ref (and so re-register the frame) on every render, which
  // is wasted churn even though it wouldn't lose iframe state.
  const setIframe = useCallback(
    (el: HTMLIFrameElement | null) => {
      if (windowRef.current) unregisterFrame(windowRef.current);
      windowRef.current = el?.contentWindow ?? null;
      if (windowRef.current) registerFrame(instanceId, tool.id, tool.isApp, windowRef.current);
    },
    [instanceId, tool.id, tool.isApp, registerFrame, unregisterFrame],
  );

  useEffect(() => {
    return () => {
      if (windowRef.current) unregisterFrame(windowRef.current);
    };
  }, [unregisterFrame]);

  // `null` — URL still resolving. The boot state, not an error; there is no
  // iframe to mount yet.
  if (frontend === null) {
    return (
      <div className="toolwindow__slot">
        <BootOverlay toolName={title} />
      </div>
    );
  }

  if (frontend.state === "unavailable") {
    return (
      <div className="toolwindow__slot">
        <UnavailableState tool={tool} reason={frontend.reason} />
      </div>
    );
  }

  return (
    <div className="toolwindow__slot">
      <iframe ref={setIframe} src={frontend.url} title={title} className="toolwindow__iframe" />
      {/* Laid over the iframe, not in place of it — the frame starts loading
          the moment its URL is known. This only disappears once this
          instance's own `hello` has been answered with `ready`. */}
      {!ready && <BootOverlay toolName={title} />}
    </div>
  );
}
