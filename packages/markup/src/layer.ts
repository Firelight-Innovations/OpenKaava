/**
 * The React half: import it with `React.lazy(() => import("@kaava/markup/layer"))`
 * so Excalidraw's script is fetched only when markup is opened.
 */
export { default as MarkupLayer } from "./MarkupLayer";
export type { MarkupController, MarkupExport, MarkupLayerProps } from "./MarkupLayer";
