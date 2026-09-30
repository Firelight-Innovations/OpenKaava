/**
 * A registry viewer that is nothing but the preview pane.
 *
 * There is no chrome of its own: the Preview button in the tab strip, and
 * Ctrl+Shift+V, are the way back to the source, so a bar here would say the same
 * thing twice.
 */
import type { ViewerProps } from "../viewer/registry";
import type { PreviewKind } from "./previewKind";
import PreviewPane from "./PreviewPane";

export default function PreviewViewer({
  kind,
  file,
  openPath,
}: ViewerProps & { kind: PreviewKind }) {
  return <PreviewPane kind={kind} path={file.path} openPath={openPath} />;
}
