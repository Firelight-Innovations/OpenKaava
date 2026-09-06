/**
 * Schematify's shell — PRD §17 Wave 2, with Wave 3's Schematic engine and
 * Wave 4's node anatomy mounted inside it. Opens the project's Stack
 * Schematic on first paint — tier 1, the highest there is, and the only one
 * nameable without already knowing what the project holds (`LANDING_PATH`,
 * `engine/navigation.ts`) — and draws the breadcrumb, the toolbar, the
 * Outline, the Schematic, the Inspector shell, the dock frame, and the status
 * bar around it.
 *
 * No title bar and no application tab strip: the real shell already draws both,
 * once, outside this iframe — see the Wave 2 handoff for that ruling.
 *
 * **The graph is read once per open Schematic.** `openSchematic` does the
 * reading, and the breadcrumb, the Outline and the status bar draw from the
 * engine's live document projected back to a graph (`engine/layout.ts`'s
 * `toGraph`), so a duplicate moves their counts the moment it appears.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { reportPainted } from "@openkaava/bridge";

// **Wave 5's tier switch.** `path` is the breadcrumb's own history: the
// Stack Schematic first, whichever Service Schematic is open, and — once a
// module has been clicked — the Module Schematic. A click on a service or a
// module (`engine/navigation.ts`'s `nextDrillTarget` decides which) appends
// to it; a click on an earlier breadcrumb segment truncates back to it. Each
// entry re-opens its own Schematic through `openSchematic`, so switching
// tiers is exactly the same "open a Schematic" path the first paint uses.
import {
  configFor,
  LANDING_PATH,
  nextDrillTarget,
  openSchematic,
  toGraph,
  type DrawnNode,
  type DrillTarget,
  type SchematicEngine,
} from "./engine";
import { SchematicCanvas } from "./engine/SchematicCanvas";
import {
  countServices,
  fetchLintReport,
  fetchModuleDashboard,
  fetchRuns,
  projectFindings,
  resolveClickThrough,
  stackHeaderCounts,
  type Dashboard,
  type Finding,
  type RunsRow,
} from "./graph";
import { productSeam, reasonForFailure, type ProductGraph } from "./graph/backend";
import { ProductPanel } from "./product/ProductPanel";
import "./product/product.css";
import { Breadcrumb } from "./shell/Breadcrumb";
import { Dock } from "./shell/Dock";
import { EmptyModule } from "./shell/EmptyModule";
import { EmptyStack } from "./shell/EmptyStack";
import { FacetPalette } from "./shell/FacetPalette";
import { InspectorShell } from "./shell/InspectorShell";
import { ModuleDashboard } from "./shell/ModuleDashboard";
import { Outline, type Section } from "./shell/Outline";
import { StatusBar } from "./shell/StatusBar";
import { Toolbar } from "./shell/Toolbar";
import "./shell/shell.css";

const VIEW_PARAM =
  typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("view") : null;
const SHOW_EMPTY_STACK = VIEW_PARAM === "empty-stack";
const SHOW_EMPTY_MODULE = VIEW_PARAM === "empty-module";

export default function App() {
  // The landing view is `engine/navigation.ts`'s `LANDING_PATH` — the stack
  // tier, the only one nameable without already knowing what the project
  // holds. That module owns it for the same reason it owns `nextDrillTarget`:
  // where navigation goes is a decision, and this component only follows one.
  const [path, setPath] = useState<readonly DrillTarget[]>(LANDING_PATH);
  const target = path[path.length - 1];
  const [engine, setEngine] = useState<SchematicEngine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const paintedRef = useRef(false);

  // Wave 7b: a Problems row's click-through that lands on a Schematic other
  // than the one already open (`resolveClickThrough`'s `navigate` case)
  // appends to `path`, which reopens the engine below — the selection has to
  // wait for that new engine to exist, so it is stashed in a ref (not state:
  // nothing should re-render off it) and applied once the open settles.
  const pendingSelectRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEngine(null);
    openSchematic(configFor(target))
      .then((opened) => {
        if (cancelled) return;
        setEngine(opened);
        if (pendingSelectRef.current) {
          opened.select([pendingSelectRef.current]);
          pendingSelectRef.current = null;
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // `target.tier`/`target.slug` are the whole identity of what to open;
    // `target` itself is a fresh object per navigation, so it is not a
    // stable dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.tier, target.slug]);

  // The Problems panel's own data (PRD §12.14): the whole project's lint
  // report, independent of which tier is open — fetched once per app
  // mount, not once per tier switch, since `schematify_core::lint` walks
  // the whole graph regardless of which Schematic a finding's own
  // `location` names (`crates/schematify-core/src/lint.rs`'s own `lint`).
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [lintError, setLintError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchLintReport()
      .then((report) => {
        if (!cancelled) setFindings(projectFindings(report));
      })
      .catch((err: unknown) => {
        if (!cancelled) setLintError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** A Problems row was clicked. `resolveClickThrough` is the pure decision
   *  (`graph/problems.ts`, unit-tested there); this is only the 2 side
   *  effects it can call for — select now, or stash and navigate. */
  function handleSelectFinding(finding: Finding): void {
    const result = resolveClickThrough({ tier: target.tier, slug: target.slug }, finding);
    if (!result) return;
    if (result.navigate) {
      pendingSelectRef.current = result.select;
      setPath([...path, result.navigate]);
    } else if (engine) {
      engine.select([result.select]);
    }
  }

  // The Runs dock tab's own data (PRD §12.2 S-14): every ingested run,
  // project-wide, fetched once per app mount — the same "not once per tier
  // switch" reasoning `findings` above already carries, and status bar cell
  // 4 reads the newest row off the same fetch rather than a 2nd call.
  const [runs, setRuns] = useState<RunsRow[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRuns()
      .then((report) => {
        if (!cancelled) setRuns([...report.runs]);
      })
      .catch((err: unknown) => {
        if (!cancelled) setRunsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The Module dashboard (PRD §12.13, S-12): opened by a Runs row or the
  // Module Schematic's own `Module dashboard` control, drawn as a full
  // overlay over the shell rather than a 4th tier — it is a read-only
  // record, not a Schematic, and PRD §12.1's breadcrumb/dock/status-bar
  // frame has nothing to say about it.
  const [dashboardModule, setDashboardModule] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  function openDashboard(moduleIdOrSlug: string): void {
    setDashboardModule(moduleIdOrSlug);
    setDashboard(null);
    setDashboardError(null);
    fetchModuleDashboard(moduleIdOrSlug)
      .then(setDashboard)
      .catch((err: unknown) => setDashboardError(err instanceof Error ? err.message : String(err)));
  }

  function closeDashboard(): void {
    setDashboardModule(null);
  }

  // The condition is "the first frame is honest", the rule every app here
  // follows (`apps/home/ui/src/App.tsx` line 246, `apps/files/ui/src/App.tsx`
  // line 78) — the empty-stack and empty-module views have nothing to load,
  // so they paint immediately; the populated view paints once the first open
  // settles, whether it resolved or rejected. Reported once: a tier switch
  // reopens `engine` (briefly `null` again) but the webview has already
  // painted by then, so a 2nd report would be redundant rather than honest.
  useEffect(() => {
    if (paintedRef.current) return;
    if (SHOW_EMPTY_STACK || SHOW_EMPTY_MODULE || engine !== null || error !== null) {
      paintedRef.current = true;
      reportPainted();
    }
  }, [engine, error]);

  // `?view=empty-stack` and `?view=empty-module` reach the 2 first-run empty
  // states directly, the same convention `EmptyStack.tsx`'s own doc comment
  // already established for the Stack Schematic.
  if (SHOW_EMPTY_STACK) {
    return (
      <div className="kv-shell">
        <EmptyStack />
      </div>
    );
  }
  if (SHOW_EMPTY_MODULE) {
    return (
      <div className="kv-shell">
        <EmptyModule />
      </div>
    );
  }

  if (error) {
    return (
      <div className="kv-shell">
        <p className="kv-shell__error">{error}</p>
      </div>
    );
  }

  if (!engine) return <div className="kv-shell" />;

  return (
    <Schematify
      engine={engine}
      path={path}
      findings={findings}
      lintError={lintError}
      runs={runs}
      runsError={runsError}
      dashboardModule={dashboardModule}
      dashboard={dashboard}
      dashboardError={dashboardError}
      onNavigate={(index) => setPath(path.slice(0, index + 1))}
      onDrillTo={(dest) => setPath([...path, dest])}
      onSelectFinding={handleSelectFinding}
      onSelectRun={openDashboard}
      onOpenDashboard={openDashboard}
      onCloseDashboard={closeDashboard}
    />
  );
}

/** The populated view, split out so the engine subscription lives where the
 *  engine is known to exist rather than behind a null check.
 *
 * `onDrillTo` is the 1 navigation primitive both the canvas's click-to-drill
 * and the Inspector's `Open module canvas` footer control (PRD §12.12, §17
 * Wave 6) push through — a click on the canvas resolves a `DrawnNode` to a
 * `DrillTarget` first (`onActivate`, below), the footer control already
 * holds one.
 *
 * **Wave 10c's section switch.** `section` names which of the Outline's 3
 * entries (PRD §12.1) is active. `Design` draws the Schematic + Inspector,
 * exactly as before this wave; `Product` and `Decisions` swap the whole
 * center body for `./product/ProductPanel` instead — see that component's
 * own doc comment for why swapping the body was chosen over drawing 4
 * surfaces inside the 238px Outline column. `productGraph` is loaded once,
 * lazily, the first time either section is opened, and re-loaded after
 * every write so the Outline's own summary line and the panel's table both
 * read the file that was just saved. */
function Schematify({
  engine,
  path,
  findings,
  lintError,
  runs,
  runsError,
  dashboardModule,
  dashboard,
  dashboardError,
  onNavigate,
  onDrillTo,
  onSelectFinding,
  onSelectRun,
  onOpenDashboard,
  onCloseDashboard,
}: {
  engine: SchematicEngine;
  path: readonly DrillTarget[];
  findings: Finding[] | null;
  lintError: string | null;
  runs: RunsRow[] | null;
  runsError: string | null;
  dashboardModule: string | null;
  dashboard: Dashboard | null;
  dashboardError: string | null;
  onNavigate: (index: number) => void;
  onDrillTo: (target: DrillTarget) => void;
  onSelectFinding: (finding: Finding) => void;
  onSelectRun: (moduleId: string) => void;
  onOpenDashboard: (moduleSlug: string) => void;
  onCloseDashboard: () => void;
}) {
  const state = useSyncExternalStore(
    (listener) => engine.subscribe(listener),
    () => engine.state,
  );
  const graph = useMemo(() => toGraph(state.doc), [state.doc]);
  // `schematify/runs` sorts newest first (`list_runs` in
  // `src-tauri/src/apps/schematify.rs`), so cell 4 needs no 2nd sort here.
  const latestRun = runs && runs.length > 0 ? runs[0] : null;

  const onActivate = (drawn: DrawnNode) => {
    const dest = nextDrillTarget(engine.config.tier, drawn.node);
    if (dest) onDrillTo(dest);
  };

  const [section, setSection] = useState<Section>("Design");
  const [productGraph, setProductGraph] = useState<ProductGraph | null>(null);
  const [productError, setProductError] = useState<string | null>(null);
  const [initialScreenId, setInitialScreenId] = useState<string | null>(null);

  const loadProduct = () => {
    productSeam
      .loadProduct()
      .then((next) => {
        setProductGraph(next);
        setProductError(null);
      })
      .catch((err: unknown) => setProductError(reasonForFailure(err)));
  };

  useEffect(() => {
    // Loaded once per open Schematic, lazily, the first time either
    // non-Design section is reached — the same "read once, project many
    // views" rule this file's own header states for the design graph,
    // applied to the product layer. A later switch back to `Product` or
    // `Decisions` reuses what is already in state rather than reloading.
    if (section !== "Design" && !productGraph && !productError) loadProduct();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  function openScreen(screenId: string) {
    setInitialScreenId(screenId);
    setSection("Product");
    if (!productGraph && !productError) loadProduct();
  }

  // PRD §12.20: "A new project opens on an empty Stack Schematic with 1
  // action: create the first service." Reachable for real now that the app
  // lands on tier 1 — before this it was drawn only for `?view=empty-stack`,
  // because the landing view named a service, and a project with no services
  // has none to name.
  //
  // It replaces the canvas, not the shell. The one action it offers is drawn
  // disabled (`schematify_write_node` is not wired), so a whole-shell takeover
  // would leave a new project on one dead button with the Outline's `Product`
  // and `Decisions` sections — the only place a brief can be written, and the
  // obvious thing to reach for before any service exists — off screen.
  const emptyStack = graph.tier === "stack" && countServices(graph) === 0;

  return (
    <div className="kv-shell">
      <div className="kv-chrome-row">
        <Breadcrumb
          segments={path.map((entry) => entry.title)}
          activeSlug={graph.serviceSlug}
          onNavigate={onNavigate}
        />
        {graph.tier === "stack" ? (
          <span className="kv-schematic-header">{stackHeaderCounts(graph)}</span>
        ) : null}
        {graph.tier === "module" ? (
          <span className="kv-schematic-header">tier 3 — deepest drill-down</span>
        ) : null}
        <Toolbar onAutoSort={() => engine.autoSort()} onFit={() => engine.fit()} />
        {graph.tier === "module" ? (
          <button
            type="button"
            className="kv-toolbar__button"
            onClick={() => onOpenDashboard(graph.serviceSlug)}
          >
            Module dashboard
          </button>
        ) : null}
      </div>
      <div className="kv-shell__body">
        <Outline
          graph={graph}
          section={section}
          onSectionChange={setSection}
          productCounts={
            productGraph
              ? {
                  screens: productGraph.screens.length,
                  flows: productGraph.flows.length,
                  decisions: productGraph.decisions.length,
                }
              : undefined
          }
        />
        {section === "Design" && emptyStack ? (
          <EmptyStack />
        ) : section === "Design" ? (
          <>
            {graph.tier === "module" ? <FacetPalette /> : null}
            <SchematicCanvas
              engine={engine}
              onActivate={onActivate}
              exports={graph.exports}
              onOpenScreen={openScreen}
            />
            <InspectorShell
              graph={graph}
              selection={state.selection}
              engine={engine}
              onOpenModuleCanvas={onDrillTo}
            />
          </>
        ) : productError ? (
          <p className="kv-shell__error">{productError}</p>
        ) : productGraph ? (
          <ProductPanel
            section={section}
            graph={productGraph}
            initialScreenId={initialScreenId}
            onSaveBrief={async (brief) => {
              await productSeam.writeBrief(brief);
              loadProduct();
            }}
            onSaveScreen={async (screen) => {
              await productSeam.writeScreen(screen);
              loadProduct();
            }}
            onSaveFlow={async (flow) => {
              await productSeam.writeFlow(flow);
              loadProduct();
            }}
            onCreateDecision={async (decision) => {
              await productSeam.writeDecision(decision);
              loadProduct();
            }}
            onSupersedeDecision={async (priorId, decision) => {
              await productSeam.supersedeDecision(priorId, decision);
              loadProduct();
            }}
          />
        ) : (
          <div className="kv-product-panel" />
        )}
      </div>
      <Dock
        findings={findings}
        error={lintError}
        onSelectFinding={onSelectFinding}
        runs={runs}
        runsError={runsError}
        onSelectRun={onSelectRun}
      />
      <StatusBar
        graph={graph}
        layoutClean={!engine.layoutDirty}
        findings={findings}
        latestRun={latestRun}
        semanticWrites={engine.semanticWrites}
      />
      {dashboardModule !== null ? (
        <ModuleDashboard dashboard={dashboard} error={dashboardError} onClose={onCloseDashboard} />
      ) : null}
    </div>
  );
}
