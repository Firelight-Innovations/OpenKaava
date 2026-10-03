/**
 * A `.mmd` file as the diagram it describes, with a way out to its source.
 *
 * Like `SvgViewer`, this owns the picture only: "View source" calls
 * `reopenWith("text")` and the registry hands the file to Monaco.
 *
 * **A render error is the normal case here, not the exception.** The person
 * looking at this pane is usually editing the diagram in the other one, and half
 * the keystrokes on the way to a valid graph produce an invalid one. So a
 * failure shows mermaid's message, kept legible, and never a blank pane — a
 * blank pane during editing reads as "the app broke" rather than "line 4 is
 * wrong". Mermaid also plants its own error `<svg>` (a little sulking figure)
 * into the document on failure; `dropStrayNodes` takes it out again, because it
 * is appended to `<body>` and would otherwise pile up behind the app.
 *
 * What it deliberately does not do: live-reload as the source changes, pan, or
 * zoom. Watching the file is the explorer's business, and re-opening the tab is
 * the escape hatch until it exists.
 */
import { useEffect, useState } from "react";
import mermaid from "mermaid";
import { describe, readText, type FileText } from "../rpc";
import type { ViewerProps } from "./registry";
import "./media.css";

/**
 * A unique DOM id per `render` call, which mermaid requires.
 *
 * Derived from a counter and not from the path: a Windows path contains colons
 * and backslashes, which are not valid in an id and which mermaid then feeds
 * straight into a CSS selector.
 */
let renders = 0;

let configured = false;

/**
 * The theme is not mermaid's `dark`. Every colour below is read out of
 * `src/tokens.css` at first use, so a diagram is drawn in the same palette as
 * the app around it and no hex value is restated here. That is also why the
 * config is built lazily rather than at module scope: it needs the stylesheet
 * to have been applied, and `getComputedStyle` on `<html>` is the only honest
 * way to ask what `--surface-2` currently is.
 */
function ensureConfigured(): void {
  if (configured) return;
  configured = true;

  const root = getComputedStyle(document.documentElement);
  const token = (name: string) => root.getPropertyValue(name).trim();

  mermaid.initialize({
    // Nothing on this page is a `.mermaid` div waiting to be swept up; every
    // render here is an explicit call.
    startOnLoad: false,
    // The file is arbitrary content from disk. `strict` runs the output through
    // DOMPurify and refuses click-handlers and inline HTML in labels, which is
    // the same argument `SvgViewer` makes for using an `<img>`.
    securityLevel: "strict",
    // `themeVariables` is only consulted under the `base` theme. Under `dark`
    // it is silently half-ignored, which looks like the overrides not working.
    theme: "base",
    fontFamily: token("--sans"), // --sans
    themeVariables: {
      darkMode: true,
      background: token("--bg"), // --bg
      fontFamily: token("--sans"), // --sans
      fontSize: "13px",

      // Nodes, and the three tiers mermaid derives most other fills from.
      primaryColor: token("--surface-2"), // --surface-2
      primaryTextColor: token("--text"), // --text
      primaryBorderColor: token("--line-2"), // --line-2
      secondaryColor: token("--surface"), // --surface
      secondaryTextColor: token("--text"), // --text
      secondaryBorderColor: token("--line"), // --line
      tertiaryColor: token("--bg"), // --bg
      tertiaryTextColor: token("--text-dim"), // --text-dim
      tertiaryBorderColor: token("--line"), // --line

      // Flowchart specifics. `mainBkg` is the fill mermaid actually reaches for
      // in most shapes; leaving it to be derived produces a washed lavender.
      mainBkg: token("--surface-2"), // --surface-2
      nodeBorder: token("--line-2"), // --line-2
      nodeTextColor: token("--text"), // --text
      clusterBkg: token("--surface"), // --surface
      clusterBorder: token("--line"), // --line
      titleColor: token("--text"), // --text
      textColor: token("--text"), // --text

      // Edges. `edgeLabelBackground` is the plate behind a label sitting on a
      // line, so it has to match the pane and not the node.
      lineColor: token("--text-dim"), // --text-dim
      edgeLabelBackground: token("--bg"), // --bg

      // Sequence diagrams draw enough of their own furniture to need naming.
      actorBkg: token("--surface-2"), // --surface-2
      actorBorder: token("--line-2"), // --line-2
      actorTextColor: token("--text"), // --text
      actorLineColor: token("--line-2"), // --line-2
      signalColor: token("--text-dim"), // --text-dim
      signalTextColor: token("--text"), // --text
      labelBoxBkgColor: token("--surface"), // --surface
      labelBoxBorderColor: token("--line"), // --line
      labelTextColor: token("--text"), // --text
      loopTextColor: token("--text-dim"), // --text-dim
      activationBkgColor: token("--surface-2"), // --surface-2
      activationBorderColor: token("--accent"), // --accent
      sequenceNumberColor: token("--bg"), // --bg

      // Notes are the one thing in a diagram meant to catch the eye.
      noteBkgColor: token("--surface"), // --surface
      noteTextColor: token("--text"), // --text
      noteBorderColor: token("--accent"), // --accent

      errorBkgColor: token("--surface"), // --surface
      errorTextColor: token("--err"), // --err
    },
  });
}

/**
 * Take mermaid's scratch nodes back out of the document.
 *
 * `render` with no container element appends the working `<svg>` under `#id`
 * and a measuring wrapper under `#d{id}` to `<body>`, and removes them itself
 * only on the success path. A file with a syntax error leaves both behind —
 * every keystroke, forever.
 */
function dropStrayNodes(id: string): void {
  document.getElementById(id)?.remove();
  document.getElementById(`d${id}`)?.remove();
}

/**
 * Render diagram source to an SVG string, for the callers that have text and no
 * file — a ```mermaid fence in a Markdown preview, or the live split. Same
 * configuration and the same `strict` sanitising as the pane below; throws
 * mermaid's own error on a syntax mistake.
 */
export async function renderDiagram(source: string): Promise<string> {
  ensureConfigured();
  const id = `mermaid-${(renders += 1)}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return svg;
  } finally {
    dropStrayNodes(id);
  }
}

type State =
  | { status: "loading" }
  | { status: "ready"; svg: string; truncated: boolean }
  | { status: "failed"; message: string };

export default function MermaidViewer({ file, reopenWith }: ViewerProps) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${(renders += 1)}`;

    setState({ status: "loading" });

    void (async () => {
      let source: FileText;
      try {
        source = await readText(file.path);
      } catch (err) {
        if (!cancelled) setState({ status: "failed", message: describe("files/read", err) });
        return;
      }
      if (cancelled) return;

      ensureConfigured();

      try {
        const { svg } = await mermaid.render(id, source.text);
        if (!cancelled) setState({ status: "ready", svg, truncated: source.truncated });
      } catch (err) {
        // Expected. Show what mermaid said — the line number is in there and it
        // is the only useful thing anyone wants from this pane right now.
        const message = err instanceof Error ? err.message : String(err);
        if (!cancelled) setState({ status: "failed", message });
      } finally {
        dropStrayNodes(id);
      }
    })();

    return () => {
      cancelled = true;
      // The render may still be in flight; mermaid offers no cancel, so the
      // scratch nodes are swept here too rather than only in `finally`.
      dropStrayNodes(id);
    };
  }, [file.path]);

  return (
    <div className="mermaid">
      <div className="mermaid__bar">
        <span className="mermaid__mode app__meta">Diagram</span>
        <button type="button" className="mermaid__toggle" onClick={() => reopenWith("text")}>
          View source
        </button>
      </div>

      <div className="mermaid__scroll">
        {state.status === "loading" && (
          <p className="app__note media__note">Rendering {file.name}…</p>
        )}
        {state.status === "failed" && (
          <div className="mermaid__broken">
            <p className="app__note">This diagram does not parse yet.</p>
            <p className="app__error">{state.message}</p>
          </div>
        )}
        {state.status === "ready" && (
          <>
            {state.truncated && (
              <p className="app__note mermaid__truncated">
                The file was longer than the read limit, so this is its first part only.
              </p>
            )}
            {/*
              Mermaid's own output, already through DOMPurify under
              `securityLevel: "strict"`. This is the one place in these viewers
              that writes markup into the document, and it is markup mermaid
              generated rather than markup the file contained.
            */}
            <div className="mermaid__canvas" dangerouslySetInnerHTML={{ __html: state.svg }} />
          </>
        )}
      </div>
    </div>
  );
}
