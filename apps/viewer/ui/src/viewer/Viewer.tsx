/**
 * Mounts whichever viewer claims the open file.
 *
 * The whole of the format dispatch is `pick(file)` on the next line but one.
 * Everything else here is the machinery around a dynamic import: caching the
 * `lazy()` wrapper so switching tabs back and forth doesn't rebuild it, a
 * fallback while the chunk is in flight, and an error boundary so a viewer that
 * throws takes out the pane rather than the app.
 *
 * The error boundary is a class because React has no hook equivalent —
 * `componentDidCatch` is the only way to catch a render-phase throw, and a
 * viewer built on Monaco, pdf.js or mermaid has three separate third-party
 * render paths that can throw for reasons this app will never enumerate.
 */
import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { byId, pick, type OpenFile, type ViewerDescriptor, type ViewerProps } from "./registry";
import { activeEditor } from "./activeEditor";
import { previewKindFor, VIEWER_ID_BY_KIND } from "../preview/previewKind";
import { createPreviewKeyMatcher } from "../preview/previewKeys";
import {
  previewControl,
  routePreviewKey,
  setPreviewControl,
  type PreviewMode,
} from "../preview/previewControl";
import { rememberTopLine } from "../preview/previewSync";
import "../preview/split.css";

/**
 * The rendered pane for the split. A separate lazy chunk from Monaco and from the
 * viewers: markdown-it and DOMPurify are fetched the first time anyone previews.
 */
const PreviewPane = lazy(() => import("../preview/PreviewPane"));

/**
 * One `lazy()` per descriptor, for the lifetime of the frame.
 *
 * `lazy()` must not be called during render with a fresh thunk each time — a
 * new component identity every render remounts the subtree on every keystroke.
 * Keyed by descriptor id rather than by file, because the chunk is per format,
 * not per document: the second `.png` opened costs nothing.
 */
const loaded = new Map<string, ComponentType<ViewerProps>>();

function componentFor(descriptor: ViewerDescriptor): ComponentType<ViewerProps> {
  const cached = loaded.get(descriptor.id);
  if (cached) return cached;
  const component = lazy(descriptor.load);
  loaded.set(descriptor.id, component);
  return component;
}

export interface ViewerHostProps {
  file: OpenFile;
  onDirty(dirty: boolean): void;
  registerSave(save: (() => Promise<void>) | null): void;
  /** Open another file in the tab strip — a relative link in a Markdown preview. */
  openPath?(path: string): void;
}

export default function Viewer({ file, onDirty, registerSave, openPath }: ViewerHostProps) {
  /**
   * A viewer id chosen at runtime, overriding what the extension implies.
   *
   * Set by `reopenWith`: the text viewer uses it to hand off to `unsupported`
   * when the backend says the file is not UTF-8, and the SVG viewer uses it to
   * toggle between the picture and its source. It is state here rather than in
   * `App.tsx` because it is a fact about *this pane right now*, not about the
   * tab — reopening the file should start from the extension's answer again.
   *
   * `App.tsx` keys this component on the path, so a tab switch discards it
   * without any reset logic here.
   */
  const [override, setOverride] = useState<string | null>(null);

  const descriptor = useMemo(() => {
    const forced = override ? byId(override) : undefined;
    return forced ?? pick(file);
  }, [file, override]);

  const Mounted = componentFor(descriptor);

  /**
   * Preview, per pane: source, the rendered form, or both side by side.
   *
   * State here for the reason `override` is — it is a fact about this pane
   * right now — and it is *published* through `previewControl` because the two
   * things that act on it, the mode bar's button and Monaco's keybinding, are not
   * descendants of this component. See `preview/`.
   */
  const [side, setSide] = useState(false);
  const kind = previewKindFor(file.ext);
  const previewId = kind ? VIEWER_ID_BY_KIND[kind] : null;
  const showingPreview = previewId !== null && descriptor.id === previewId;
  const mode: PreviewMode =
    side && descriptor.id === "text" ? "side" : showingPreview ? "preview" : "source";

  /** Carry the editor's scroll position to whichever pane is about to appear. */
  const captureLine = useCallback(() => {
    const line = activeEditor()?.getVisibleRanges()[0]?.startLineNumber;
    if (line !== undefined) rememberTopLine(file.path, line);
  }, [file.path]);

  const toggle = useCallback(() => {
    if (previewId === null) return;
    if (mode === "side") {
      setSide(false);
      return;
    }
    // `unsupported` is a dead end the user did not choose to leave through here.
    if (descriptor.id !== "text" && !showingPreview) return;
    captureLine();
    setSide(false);
    setOverride(showingPreview ? "text" : previewId);
  }, [previewId, mode, descriptor.id, showingPreview, captureLine]);

  const toggleSide = useCallback(() => {
    if (previewId === null) return;
    if (mode === "side") {
      setSide(false);
      return;
    }
    if (descriptor.id !== "text" && !showingPreview) return;
    captureLine();
    setOverride("text");
    setSide(true);
  }, [previewId, mode, descriptor.id, showingPreview, captureLine]);

  useEffect(() => {
    if (kind === null) return;
    setPreviewControl({ kind, mode, toggle, toggleSide });
    return () => setPreviewControl(null);
  }, [kind, mode, toggle, toggleSide]);

  /**
   * Ctrl+Shift+V and Ctrl+K V for whatever in this frame has focus — the tab
   * strip, a rendered pane, or the editor when Monaco lets a key through. Monaco
   * has the same two bound on itself (`bindPreview`) and wins inside the editor,
   * calling `preventDefault`, which is why this backs off from a handled event.
   * It exists only in this frame: the shell never sees the key, so a terminal
   * elsewhere keeps Ctrl+Shift+V as paste.
   */
  const matcher = useMemo(() => createPreviewKeyMatcher(), []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (routePreviewKey(matcher, previewControl(), event)) event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [matcher]);

  const mounted = (
    <Suspense
      fallback={
        <p className="app__note viewer__pending">
          Loading {descriptor.label.toLowerCase()} viewer…
        </p>
      }
    >
      <Mounted
        file={file}
        onDirty={onDirty}
        registerSave={registerSave}
        reopenWith={setOverride}
        openPath={openPath}
      />
    </Suspense>
  );

  return (
    <div className="viewer">
      <ViewerBoundary
        // Remount the boundary when the viewer changes, or a viewer that
        // errored would keep its "failed" state after a `reopenWith` that was
        // the user's way of getting out of it.
        key={`${file.path}:${descriptor.id}`}
        file={file}
      >
        {mode === "side" && kind !== null ? (
          <div className="viewer__split">
            <div className="viewer__half">{mounted}</div>
            <div className="viewer__half viewer__half--preview">
              <Suspense fallback={<p className="app__note viewer__pending">Loading preview…</p>}>
                <PreviewPane kind={kind} path={file.path} openPath={openPath} followEditor />
              </Suspense>
            </div>
          </div>
        ) : (
          mounted
        )}
      </ViewerBoundary>
    </div>
  );
}

interface BoundaryProps {
  file: OpenFile;
  children: ReactNode;
}

interface BoundaryState {
  message: string | null;
}

/**
 * A failed viewer, drawn as a failed viewer.
 *
 * The message is shown verbatim rather than replaced with a generic line. A
 * chunk that failed to load, a PDF that pdf.js rejected and a mermaid document
 * with a syntax error all land here, and the only thing that tells them apart
 * is what the library said.
 */
class ViewerBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (this.state.message === null) return this.props.children;
    return (
      <div className="viewer__failed">
        <p className="app__note">Could not show {this.props.file.name}.</p>
        <p className="app__error">{this.state.message}</p>
      </div>
    );
  }
}
