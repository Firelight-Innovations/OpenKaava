import type { PageInfo } from "../../bindings";
import "./apppage.css";

export interface AppPageProps {
  /** The page as the backend lists it; `appId` says whether an app draws it. */
  page: PageInfo | undefined;
  /** The page's entry in `ShellSnapshot.instances`, minted by `open_page`. */
  instanceId: string | null | undefined;
  /** Hands the host element up, so the tool window can portal the app's iframe into it. */
  onHost: (el: HTMLElement | null) => void;
}

/**
 * The body of a docked or expanded page that is drawn by an app.
 *
 * This draws no iframe itself: `ToolWindow` owns every frame's handshake, so
 * it mounts the page's `ToolMount` into this element through a portal. What is
 * here is the box that iframe fills. A page with no app, or one whose instance
 * has not arrived on `shell:state` yet, says so plainly instead.
 */
export default function AppPage({ page, instanceId, onHost }: AppPageProps) {
  if (!page?.appId || !instanceId) {
    return (
      <div style={{ padding: 16, color: "var(--txt-tertiary)", fontSize: 13 }}>
        {page?.name ?? "This page"} is not wired to its app yet.
      </div>
    );
  }
  return <div className="k-app-page" data-page-app={page.appId} ref={onHost} />;
}
