/** An HTML file in a scriptless, networkless sandbox. See `preview/PreviewPane`. */
import PreviewViewer from "../preview/PreviewViewer";
import type { ViewerProps } from "./registry";

export default function HtmlViewer(props: ViewerProps) {
  return <PreviewViewer {...props} kind="html" />;
}
