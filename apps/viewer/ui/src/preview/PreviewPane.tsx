/**
 * The rendered form of a file, drawn from its text.
 *
 * One component for every previewable kind, used two ways: as the whole pane
 * (`MarkdownViewer`, `HtmlViewer`, reached with Ctrl+Shift+V) and as the right
 * half of a split (Ctrl+K V), where `followEditor` ties its scroll to the editor
 * beside it. Text comes from `useLiveText`, so both are live.
 *
 * Markdown is where the work is. The HTML arrives sanitised from `markdown.ts`,
 * and three things are done to it afterwards, each asynchronous and each
 * cancelled if the text changes underneath it: relative images are fetched
 * through the backend and swapped for object URLs (a webview has no business
 * reading `file://`), code fences are tokenised by Monaco, and ```mermaid fences
 * become diagrams. Results are cached by content, so editing one paragraph does
 * not redraw every diagram on the page.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { describe, openUrl, readBytes, toBytes } from "../rpc";
import { activeEditor, subscribeActiveEditor } from "../viewer/activeEditor";
import { mimeFor } from "../viewer/blobUrl";
import { ANCHOR_PREFIX, renderMarkdown } from "./markdown";
import { tokensToHtml } from "./highlight";
import { classifyLink, isRelative, resolveRelative } from "./paths";
import { peekTopLine, rememberTopLine } from "./previewSync";
import type { PreviewKind } from "./previewKind";
import { useLiveText } from "./useLiveText";
import "./preview.css";

export interface PreviewPaneProps {
  kind: PreviewKind;
  path: string;
  /** Open a sibling document from a relative link. */
  openPath?: (path: string) => void;
  /** Scroll along with the editor beside this pane. Split mode only. */
  followEditor?: boolean;
}

/** Diagrams and highlighted blocks by content, so an unchanged one is not redone. */
const diagramCache = new Map<string, string>();
const highlightCache = new Map<string, string>();
const CACHE_LIMIT = 200;

function remember(cache: Map<string, string>, key: string, value: string): void {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
}

export default function PreviewPane({ kind, path, openPath, followEditor }: PreviewPaneProps) {
  const live = useLiveText(path);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  if (live.status === "loading") {
    return <p className="app__note preview__note">Rendering…</p>;
  }
  if (live.status === "failed") {
    return <p className="app__error preview__note">{live.message}</p>;
  }

  return (
    <div className="preview" data-kind={kind}>
      {live.truncated && (
        <p className="preview__notice app__note">
          The file was longer than the read limit, so this shows its first part only.
        </p>
      )}
      <div className="preview__scroll" ref={scrollRef}>
        {kind === "markdown" && (
          <MarkdownBody
            path={path}
            text={live.text}
            scrollRef={scrollRef}
            openPath={openPath}
            followEditor={followEditor === true}
          />
        )}
        {kind === "mermaid" && <DiagramBody text={live.text} />}
        {kind === "svg" && <SvgBody text={live.text} name={path} />}
        {kind === "html" && <HtmlBody text={live.text} />}
      </div>
    </div>
  );
}

// --- Markdown -----------------------------------------------------------------

interface MarkdownBodyProps {
  path: string;
  text: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  openPath?: (path: string) => void;
  followEditor: boolean;
}

/** The scroll offset of the block for source line `line`, or `null` if there are none. */
function offsetForLine(scroller: HTMLElement, line: number): number | null {
  const blocks = scroller.querySelectorAll<HTMLElement>("[data-line]");
  let best: HTMLElement | null = null;
  for (const block of Array.from(blocks)) {
    if (Number(block.dataset.line) > line) break;
    best = block;
  }
  if (!best) return blocks.length > 0 ? 0 : null;
  return (
    best.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  );
}

/** The source line of the first block whose bottom edge is below the top of the pane. */
function lineAtTop(scroller: HTMLElement): number | null {
  const top = scroller.getBoundingClientRect().top;
  for (const block of Array.from(scroller.querySelectorAll<HTMLElement>("[data-line]"))) {
    if (block.getBoundingClientRect().bottom > top + 1) return Number(block.dataset.line);
  }
  return null;
}

function MarkdownBody({ path, text, scrollRef, openPath, followEditor }: MarkdownBodyProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rendered = useMemo(() => renderMarkdown(text), [text]);
  const [notice, setNotice] = useState<string | null>(null);
  const editor = useSyncExternalStore(subscribeActiveEditor, activeEditor);
  const arrived = useRef(false);

  // Live updates replace the markup. Put the scroll back where it was, or every
  // pause in typing would snap the preview to the top.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (!arrived.current) {
      arrived.current = true;
      const line = peekTopLine(path);
      const offset = line !== undefined ? offsetForLine(scroller, line) : null;
      if (offset !== null) scroller.scrollTop = offset;
    }
  }, [rendered.html, path, scrollRef]);

  // Report the top line as the reader scrolls, for the toggle back to source.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const line = lineAtTop(scroller);
        if (line !== null) rememberTopLine(path, line);
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [path, scrollRef]);

  // Split mode: the editor drives.
  useEffect(() => {
    if (!followEditor || !editor) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const follow = () => {
      const line = editor.getVisibleRanges()[0]?.startLineNumber;
      if (line === undefined) return;
      const offset = offsetForLine(scroller, line);
      if (offset !== null) scroller.scrollTop = offset;
    };
    follow();
    const subscription = editor.onDidScrollChange(follow);
    return () => subscription.dispose();
  }, [followEditor, editor, scrollRef, rendered.html]);

  // Everything that has to happen to the DOM after the sanitised HTML lands.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let cancelled = false;
    const urls: string[] = [];

    for (const img of Array.from(body.querySelectorAll("img"))) {
      const src = img.getAttribute("src") ?? "";
      if (!isRelative(src)) continue;
      const resolved = resolveRelative(path, src);
      if (resolved === null) continue;
      const ext = (resolved.split(".").pop() ?? "").toLowerCase();
      void readBytes(resolved)
        .then((file) => {
          if (cancelled) return;
          const url = URL.createObjectURL(
            new Blob([toBytes(file.base64) as BlobPart], { type: mimeFor(ext) }),
          );
          urls.push(url);
          img.src = url;
        })
        .catch(() => {
          if (cancelled) return;
          img.classList.add("md__img--missing");
          img.alt = img.alt || src;
          img.title = `Could not load ${src}`;
        });
    }

    void (async () => {
      for (const code of Array.from(
        body.querySelectorAll<HTMLElement>("pre > code[class*='language-']"),
      )) {
        if (cancelled) return;
        if (code.closest(".md__mermaid")) continue;
        const word = /language-(\S+)/.exec(code.className)?.[1];
        if (!word) continue;
        const source = (code.textContent ?? "").replace(/\n$/, "");
        const key = `${word}\u0000${source}`;
        let html = highlightCache.get(key);
        if (html === undefined) {
          try {
            const { tokenizeFence } = await import("../viewer/monaco");
            const tokenized = await tokenizeFence(source, word);
            if (!tokenized) continue;
            html = tokensToHtml(tokenized.lines, tokenized.tokens);
            remember(highlightCache, key, html);
          } catch {
            continue;
          }
        }
        if (!cancelled) code.innerHTML = html;
      }
    })();

    if (rendered.hasMermaid) {
      void (async () => {
        for (const holder of Array.from(body.querySelectorAll<HTMLElement>(".md__mermaid"))) {
          if (cancelled) return;
          const source = holder.textContent ?? "";
          let svg = diagramCache.get(source);
          try {
            if (svg === undefined) {
              const { renderDiagram } = await import("../viewer/MermaidViewer");
              svg = await renderDiagram(source);
              remember(diagramCache, source, svg);
            }
            if (cancelled) return;
            // Mermaid's own output, sanitised by mermaid under `strict`. Not
            // markup from the file.
            holder.innerHTML = svg;
            holder.classList.add("md__mermaid--ready");
          } catch (err) {
            if (cancelled) return;
            const message = document.createElement("p");
            message.className = "md__mermaid-error";
            message.textContent = err instanceof Error ? err.message : String(err);
            holder.appendChild(message);
          }
        }
      })();
    }

    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [rendered.html, rendered.hasMermaid, path]);

  const onClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (event.target as Element).closest("a");
      const href = anchor?.getAttribute("href");
      if (!anchor || !href) return;
      // Every link is handled here; none is allowed to navigate the frame.
      event.preventDefault();

      const target = classifyLink(path, href);
      if (target.kind === "anchor") {
        const body = bodyRef.current;
        const el =
          body?.querySelector(`[id="${CSS.escape(ANCHOR_PREFIX + target.id)}"]`) ??
          body?.querySelector(`[id="${CSS.escape(target.id)}"]`);
        el?.scrollIntoView({ block: "start" });
      } else if (target.kind === "external") {
        setNotice(null);
        openUrl(target.url).catch((err: unknown) => setNotice(describe("files/open-url", err)));
      } else if (target.kind === "file") {
        openPath?.(target.path);
      }
    },
    [path, openPath],
  );

  return (
    <>
      {notice && <p className="app__error preview__notice">{notice}</p>}
      {/*
        Sanitised by DOMPurify in `renderMarkdown` — see the header of
        `markdown.ts`. This is the one place the app writes file-derived markup
        into its document, and it is markup that has been through that filter.
      */}
      <div
        ref={bodyRef}
        className="md"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: rendered.html }}
      />
    </>
  );
}

// --- the other kinds -------------------------------------------------------------

/** A ```mermaid file. Keeps the last good diagram on screen while the source is broken. */
function DiagramBody({ text }: { text: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void import("../viewer/MermaidViewer")
      .then(({ renderDiagram }) => renderDiagram(text))
      .then((next) => {
        if (cancelled) return;
        setSvg(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [text]);

  return (
    <div className="preview__diagram">
      {error && (
        <div className="preview__broken">
          <p className="app__note">This diagram does not parse yet.</p>
          <p className="app__error">{error}</p>
        </div>
      )}
      {/* Mermaid's own `strict`-sanitised output. */}
      {svg && <div className="preview__canvas" dangerouslySetInnerHTML={{ __html: svg }} />}
    </div>
  );
}

/**
 * An SVG, through an `<img>` — the boundary `SvgViewer` documents. Scripts do not
 * run and nothing external loads; the markup is never inlined into this document.
 */
function SvgBody({ text, name }: { text: string; name: string }) {
  const url = useMemo(
    () => URL.createObjectURL(new Blob([text], { type: "image/svg+xml" })),
    [text],
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="preview__diagram">
      <img className="preview__svg" src={url} alt={name} draggable={false} />
    </div>
  );
}

/**
 * HTML in a frame that can do nothing: `sandbox` with no tokens (no scripts, no
 * same-origin, no forms, no navigation) and a `csp` that also forbids every
 * network fetch. What renders is the document's structure and inline styling;
 * relative stylesheets and images do not load, by design.
 */
const HTML_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

function HtmlBody({ text }: { text: string }) {
  return (
    <iframe
      className="preview__html"
      title="HTML preview"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={text}
      // `csp` is Chromium's embedded-enforcement attribute; React passes it through
      // and the DOM typings do not know it.
      {...{ csp: HTML_CSP }}
    />
  );
}
