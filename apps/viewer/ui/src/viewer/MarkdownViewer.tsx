/** A Markdown file, rendered. Reached by Ctrl+Shift+V; see `preview/`. */
import PreviewViewer from "../preview/PreviewViewer";
import type { ViewerProps } from "./registry";

export default function MarkdownViewer(props: ViewerProps) {
  return <PreviewViewer {...props} kind="markdown" />;
}
