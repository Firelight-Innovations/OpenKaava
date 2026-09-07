/**
 * The Inspector (PRD §12.12, §17 Wave 6) — S-04 through S-11, the tab strip's
 * `More` overflow, the export-list editor, and the 2 footer controls. Every
 * count, chip and label below comes from `engine/inspector.ts`'s pure
 * functions — this file only maps their output onto markup, per `anatomy.ts`'s
 * "the renderer decides nothing" rule.
 *
 * **Wave 5's one exception, kept as-is**: PRD §12.9 puts the Stack
 * Schematic's own empty state — `CANVAS PROPERTIES` plus the derived tech
 * stack — in this same panel; it draws only when nothing is selected on the
 * Stack Schematic. Every other case below is Wave 6 scope.
 */
import { useState } from "react";
import {
  budgetsContent,
  contractContent,
  dependenciesContent,
  docsContent,
  identityContent,
  lifecycleContent,
  referencesContent,
  tabStripFor,
  testsContent,
  MORE_TAB_IDS,
  NARROW_PANEL_WIDTH,
  TAB_LABEL,
  type InspectorNode,
  type InspectorTabId,
} from "../engine/inspector";
import { nextDrillTarget, type DrillTarget, type SchematicEngine } from "../engine";
import { countEdges, countServices, computeDepth, plural, type SchematicGraph } from "../graph";

export interface InspectorShellProps {
  /** Omitted keeps the plain tab-strip placeholder — every caller before
   *  Wave 5 rendered `<InspectorShell />` with no props at all. */
  graph?: SchematicGraph;
  /** The engine's own selection, by id — `state.selection` from `App.tsx`.
   *  Only the first id drives the panel; PRD §12.12 draws 1 node's content
   *  at a time. */
  selection?: readonly string[];
  /** Present once a real Schematic is open — what `editNode`/`addFacet`/
   *  `dropFacet` write through. Absent only for the placeholder render. */
  engine?: SchematicEngine;
  /** The footer's `Open module canvas` control (PRD §12.12) — the same
   *  navigation `SchematicCanvas.tsx`'s own click-to-drill already performs. */
  onOpenModuleCanvas?: (target: DrillTarget) => void;
  /** Overrides the panel's own width for the 360/380 layout switch (PRD §17
   *  Wave 6's acceptance condition). Defaults to the shell's real column
   *  width — see the Wave 6 handoff for why this is a prop and not a live
   *  resize measurement. */
  panelWidthPx?: number;
}

function copyToClipboard(text: string): void {
  navigator.clipboard.writeText(text).catch(() => {
    // Nothing more to do — the field stays selectable by hand.
  });
}

export function InspectorShell({
  graph,
  selection = [],
  engine,
  onOpenModuleCanvas,
  panelWidthPx = NARROW_PANEL_WIDTH,
}: InspectorShellProps) {
  if (graph && graph.tier === "stack" && selection.length === 0) {
    return <CanvasProperties graph={graph} />;
  }
  if (!graph) {
    return <PlaceholderStrip />;
  }
  const selected = graph.nodes.find((node) => node.id === selection[0]);
  const strip = tabStripFor(panelWidthPx);
  const wide = !strip.hasMore;

  return (
    <PopulatedInspector
      graph={graph}
      selected={selected}
      engine={engine}
      onOpenModuleCanvas={onOpenModuleCanvas}
      wide={wide}
      strip={strip.tabs}
    />
  );
}

/** Every caller before Wave 5 rendered `<InspectorShell />` with no `graph`
 *  at all — kept as the fallback so that call shape still renders something. */
function PlaceholderStrip() {
  return (
    <div className="kv-inspector">
      <div className="kv-inspector__tabs" role="tablist">
        {(["Identity", "Lifecycle", "Contract", "Tests", "More"] as const).map((tab, index) => (
          <span
            key={tab}
            className={`kv-inspector__tab${index === 0 ? " kv-inspector__tab--active" : ""}`}
            role="tab"
            aria-selected={index === 0}
          >
            {tab}
          </span>
        ))}
      </div>
      <p className="kv-inspector__placeholder">Nothing to inspect.</p>
    </div>
  );
}

function PopulatedInspector({
  graph,
  selected,
  engine,
  onOpenModuleCanvas,
  wide,
  strip,
}: {
  graph: SchematicGraph;
  selected: InspectorNode | undefined;
  engine: SchematicEngine | undefined;
  onOpenModuleCanvas: ((target: DrillTarget) => void) | undefined;
  wide: boolean;
  strip: InspectorTabId[];
}) {
  const [active, setActive] = useState<InspectorTabId>("identity");
  const [moreOpen, setMoreOpen] = useState(false);

  if (!selected) {
    return (
      <div className={`kv-inspector${wide ? " kv-inspector--wide" : ""}`}>
        <TabStripBar strip={strip} active={active} onSelect={setActive} moreOpen={moreOpen} />
        <p className="kv-inspector__placeholder">Nothing selected.</p>
      </div>
    );
  }

  const facets = graph.nodes.filter((node) => node.parentId === selected.id) as InspectorNode[];
  const edges = graph.edges;
  const titleOf = (id: string) => graph.nodes.find((node) => node.id === id)?.title ?? id;

  const showTab = moreOpen ? active : strip.includes(active) ? active : "identity";

  const drillTarget = selected.kind === "module" ? nextDrillTarget(graph.tier, selected) : null;
  const showFooter = selected.kind === "module";

  return (
    <div className={`kv-inspector${wide ? " kv-inspector--wide" : ""}`}>
      <TabStripBar
        strip={strip}
        active={showTab}
        onSelect={(tab) => {
          setMoreOpen(false);
          setActive(tab);
        }}
        moreOpen={moreOpen}
        onMore={() => setMoreOpen(true)}
      />
      {moreOpen ? (
        <MoreStripBar
          active={MORE_TAB_IDS.includes(showTab) ? showTab : MORE_TAB_IDS[0]}
          onSelect={setActive}
        />
      ) : null}

      <div className="kv-inspector__panel">
        {showTab === "identity" ? <IdentityPanel node={selected} /> : null}
        {showTab === "lifecycle" ? <LifecyclePanel node={selected} /> : null}
        {showTab === "contract" ? (
          <ContractPanel node={selected} facets={facets} edges={edges} engine={engine} />
        ) : null}
        {showTab === "tests" ? <TestsPanel facets={facets} /> : null}
        {showTab === "budgets" ? (
          <BudgetsPanel node={selected} facets={facets} engine={engine} />
        ) : null}
        {showTab === "dependencies" ? (
          <DependenciesPanel node={selected} facets={facets} edges={edges} titleOf={titleOf} />
        ) : null}
        {showTab === "docs" ? <DocsPanel facets={facets} engine={engine} /> : null}
        {showTab === "references" ? <ReferencesPanel node={selected} /> : null}
      </div>

      {showFooter ? (
        <div className="kv-inspector__footer-controls">
          {drillTarget ? (
            <button
              type="button"
              className="kv-inspector__footer-button"
              onClick={() => onOpenModuleCanvas?.(drillTarget)}
            >
              Open module canvas
            </button>
          ) : null}
          <button
            type="button"
            className="kv-inspector__footer-button"
            onClick={() => engine?.editNode(selected.id, { assignee: "you" })}
          >
            Assign
          </button>
        </div>
      ) : null}
    </div>
  );
}

function TabStripBar({
  strip,
  active,
  onSelect,
  moreOpen,
  onMore,
}: {
  strip: InspectorTabId[];
  active: InspectorTabId;
  onSelect: (tab: InspectorTabId) => void;
  moreOpen: boolean;
  onMore?: () => void;
}) {
  const hasMore = strip.length < 5;
  return (
    <div className="kv-inspector__tabs" role="tablist">
      {strip.map((tab) => (
        <button
          key={tab}
          type="button"
          className={`kv-inspector__tab${active === tab && !moreOpen ? " kv-inspector__tab--active" : ""}`}
          role="tab"
          aria-selected={active === tab && !moreOpen}
          onClick={() => onSelect(tab)}
        >
          {TAB_LABEL[tab]}
        </button>
      ))}
      {hasMore ? (
        <button
          type="button"
          className={`kv-inspector__tab${moreOpen ? " kv-inspector__tab--active" : ""}`}
          role="tab"
          aria-selected={moreOpen}
          onClick={onMore}
        >
          More
        </button>
      ) : null}
    </div>
  );
}

function MoreStripBar({
  active,
  onSelect,
}: {
  active: InspectorTabId;
  onSelect: (tab: InspectorTabId) => void;
}) {
  return (
    <div className="kv-inspector__more-tabs" role="tablist">
      {MORE_TAB_IDS.map((tab) => (
        <button
          key={tab}
          type="button"
          className={`kv-inspector__tab${active === tab ? " kv-inspector__tab--active" : ""}`}
          role="tab"
          aria-selected={active === tab}
          onClick={() => onSelect(tab)}
        >
          {TAB_LABEL[tab]}
        </button>
      ))}
    </div>
  );
}

// --- Identity (S-04) --------------------------------------------------------

function IdentityPanel({ node }: { node: InspectorNode }) {
  const content = identityContent(node);
  return (
    <div className="kv-inspector__fields">
      <Field label="TITLE" value={content.title} />
      <Field label="SLUG" value={content.slug} />
      {content.description ? <Field label="DESCRIPTION" value={content.description} /> : null}
      <div className="kv-inspector__field">
        <div className="kv-inspector__field-label">OPAQUE ID</div>
        <button
          type="button"
          className="kv-inspector__copy-field"
          onClick={() => copyToClipboard(content.opaqueId)}
          title="copy"
        >
          {content.opaqueId}
        </button>
      </div>
      <Field label="KIND" value={content.kind} />
      {content.layer ? <Field label="LAYER" value={content.layer} /> : null}
      {content.decisions.length > 0 ? (
        <Field label="DECISIONS" value={content.decisions.join(", ")} />
      ) : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv-inspector__field">
      <div className="kv-inspector__field-label">{label}</div>
      <div className="kv-inspector__field-value">{value}</div>
    </div>
  );
}

// --- Lifecycle (S-05) --------------------------------------------------------

function LifecyclePanel({ node }: { node: InspectorNode }) {
  const content = lifecycleContent(node);
  return (
    <div className="kv-inspector__fields">
      <Field label="STATE" value={content.state} />
      <div className="kv-inspector__field">
        <div className="kv-inspector__field-label">LEGAL TRANSITIONS</div>
        <ul className="kv-inspector__list">
          {content.transitions.map((t) => (
            <li key={t.to}>
              → {t.to} ({t.actor})
            </li>
          ))}
        </ul>
      </div>
      <Field label="ASSIGNEE" value={content.assignee ?? "—"} />
      <div className="kv-inspector__field">
        <div className="kv-inspector__field-label">RECENT AUDIT</div>
        <ul className="kv-inspector__list">
          {content.recentAudit.map((row) => (
            <li key={row.when}>
              {row.when} · {row.transition} · {row.actor}
            </li>
          ))}
        </ul>
        <a className="kv-inspector__link" href="#runs">
          {content.auditLogLinkLabel}
        </a>
      </div>
    </div>
  );
}

// --- Contract (S-06) ---------------------------------------------------------

function ContractPanel({
  node,
  facets,
  edges,
  engine,
}: {
  node: InspectorNode;
  facets: InspectorNode[];
  edges: readonly { kind: string; from: string; to: string }[];
  engine: SchematicEngine | undefined;
}) {
  const [openApi, setOpenApi] = useState(false);
  const [newMethod, setNewMethod] = useState("");
  const [newModuleSlug, setNewModuleSlug] = useState("");
  const content = contractContent(node, facets, edges);
  const blocks = content.mode === "exports" ? content.resolvedMethods : content.methods;

  return (
    <div className="kv-inspector__fields">
      <div className="kv-inspector__count-header">{content.countLabel}</div>
      <div className="kv-inspector__toggle" role="tablist">
        <button
          type="button"
          className={openApi ? "" : "kv-inspector__tab--active"}
          onClick={() => setOpenApi(false)}
        >
          Signatures
        </button>
        <button
          type="button"
          className={openApi ? "kv-inspector__tab--active" : ""}
          onClick={() => setOpenApi(true)}
        >
          OpenAPI
        </button>
      </div>

      {content.mode === "exports" ? (
        <>
          {/* PRD §17 Wave 6: "Build the export-list editor on a service
              node." Every edit replaces the whole `exports` array through 1
              `editNode` call, so an add or a remove still writes exactly 1
              file (this wave's own acceptance condition). */}
          <ul className="kv-inspector__list">
            {content.exportRows.map((row) => (
              <li key={row.method}>
                {row.method} → {row.moduleSlug}
                <button
                  type="button"
                  className="kv-inspector__footer-button"
                  onClick={() =>
                    engine?.editNode(node.id, {
                      exports: content.exportRows.filter((r) => r.method !== row.method),
                    })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div className="kv-inspector__footer-controls">
            <input
              className="kv-inspector__copy-field"
              placeholder="method name"
              value={newMethod}
              onChange={(e) => setNewMethod(e.target.value)}
            />
            <input
              className="kv-inspector__copy-field"
              placeholder="owning module"
              value={newModuleSlug}
              onChange={(e) => setNewModuleSlug(e.target.value)}
            />
            <button
              type="button"
              className="kv-inspector__footer-button"
              onClick={() => {
                if (!newMethod || !newModuleSlug) return;
                engine?.editNode(node.id, {
                  exports: [
                    ...content.exportRows,
                    { method: newMethod, moduleSlug: newModuleSlug },
                  ],
                });
                setNewMethod("");
                setNewModuleSlug("");
              }}
            >
              Add export
            </button>
          </div>
        </>
      ) : null}

      {openApi || content.mode === "exports" ? (
        <ul className="kv-inspector__method-blocks">
          {blocks.map((method) => (
            <li key={method.name} className="kv-inspector__method-block">
              <div className="kv-inspector__method-name">
                {method.name}
                {method.exported ? <span className="kv-inspector__badge">EXPORTED</span> : null}
              </div>
              <div className="kv-inspector__method-signature">
                {method.signature} → {method.returns}
              </div>
              {method.semantics ? (
                <div className="kv-inspector__body">{method.semantics}</div>
              ) : null}
              <div className="kv-inspector__covers-label">{method.coversLabel}</div>
            </li>
          ))}
        </ul>
      ) : null}

      {content.mode === "methods" ? (
        <button
          type="button"
          className="kv-inspector__footer-button"
          onClick={() =>
            engine?.addFacet(node.id, "contract-method", {
              title: "",
              signature: "()",
              returns: "void",
            })
          }
        >
          {content.addMethodLabel}
        </button>
      ) : null}
    </div>
  );
}

// --- Tests (S-07) -------------------------------------------------------------

function TestsPanel({ facets }: { facets: InspectorNode[] }) {
  const content = testsContent(facets);
  return (
    <div className="kv-inspector__fields">
      <div className="kv-inspector__count-header">{content.countLabel}</div>
      <div className="kv-inspector__chips">
        {content.chips.map((chip) => (
          <span key={chip} className="kv-inspector__chip">
            {chip}
          </span>
        ))}
      </div>
      <ul className="kv-inspector__method-blocks">
        {content.cases.map((testCase) => (
          <li key={testCase.title} className="kv-inspector__method-block">
            <div className="kv-inspector__method-name">{testCase.title}</div>
            {testCase.given || testCase.when || testCase.then ? (
              <div className="kv-inspector__body">
                given {testCase.given} when {testCase.when} then {testCase.then}
              </div>
            ) : null}
            {testCase.markerToken ? (
              <div className="kv-inspector__marker-token">{testCase.markerToken}</div>
            ) : null}
            <div className="kv-inspector__body">{testCase.statusLine}</div>
            {testCase.mismatch ? (
              <div className="kv-inspector__mismatch">{testCase.mismatch}</div>
            ) : null}
            {testCase.showCopyMarkerControl ? (
              <button
                type="button"
                className="kv-inspector__footer-button"
                onClick={() => testCase.markerToken && copyToClipboard(testCase.markerToken)}
              >
                Copy marker token
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Budgets (S-08) -----------------------------------------------------------

function BudgetsPanel({
  node,
  facets,
  engine,
}: {
  node: InspectorNode;
  facets: InspectorNode[];
  engine: SchematicEngine | undefined;
}) {
  const content = budgetsContent(node, facets);
  return (
    <div className="kv-inspector__fields">
      <div className="kv-inspector__count-header">
        {content.countLabel}
        {content.runReference ? ` · ${content.runReference}` : ""}
      </div>
      <ul className="kv-inspector__method-blocks">
        {content.rows.map((row) => {
          const facet = facets.find((child) => child.title === row.metric);
          return (
            <li key={row.metric} className="kv-inspector__method-block">
              <div className="kv-inspector__method-name">
                {row.metric}
                <span className="kv-inspector__badge">{row.tierBadge}</span>
              </div>
              <div className="kv-inspector__method-signature">
                {row.value}
                {row.threshold ? ` · ${row.threshold}` : ""}
              </div>
              {row.state === "trending" ? (
                <>
                  <div className="kv-inspector__body">{content.trendingNote}</div>
                  <button
                    type="button"
                    className="kv-inspector__footer-button"
                    onClick={() => facet && engine?.editNode(facet.id, { budgetSignOff: "you" })}
                  >
                    Sign off
                  </button>
                </>
              ) : null}
              {row.state === "no-probe" ? (
                <>
                  <div className="kv-inspector__method-name">{content.noProbeLabel}</div>
                  <div className="kv-inspector__body">{content.noProbeNote}</div>
                  <div className="kv-inspector__footer-controls">
                    <button
                      type="button"
                      className="kv-inspector__footer-button"
                      onClick={() =>
                        facet && engine?.editNode(facet.id, { budgetProbe: "pnpm bench:new-probe" })
                      }
                    >
                      Add probe
                    </button>
                    <button
                      type="button"
                      className="kv-inspector__footer-button"
                      onClick={() => facet && engine?.dropFacet(facet.id)}
                    >
                      Drop budget
                    </button>
                  </div>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// --- Dependencies (S-09) -------------------------------------------------------

function DependenciesPanel({
  node,
  facets,
  edges,
  titleOf,
}: {
  node: InspectorNode;
  facets: InspectorNode[];
  edges: readonly { kind: string; from: string; to: string }[];
  titleOf: (id: string) => string;
}) {
  const content = dependenciesContent(node, facets, edges, titleOf);
  return (
    <div className="kv-inspector__fields">
      <div className="kv-inspector__field">
        <div className="kv-inspector__field-label">INTERNAL (READ-ONLY)</div>
        <ul className="kv-inspector__list">
          {content.internal.map((row) => (
            <li key={row.title}>
              {row.direction === "depends_on" ? "→" : "←"} {row.title}
            </li>
          ))}
        </ul>
      </div>
      <div className="kv-inspector__field">
        <div className="kv-inspector__field-label">EXTERNAL LIBRARIES</div>
        <ul className="kv-inspector__list">
          {content.external.map((lib) => (
            <li key={lib.name}>
              {lib.name} {lib.version} · {lib.license}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// --- Docs (S-10) ----------------------------------------------------------------

function DocsPanel({
  facets,
  engine,
}: {
  facets: InspectorNode[];
  engine: SchematicEngine | undefined;
}) {
  const content = docsContent(facets);
  const docNode = facets.find((facet) => facet.kind === "doc-block");
  return (
    <div className="kv-inspector__fields">
      <textarea
        className="kv-inspector__doc-editor"
        defaultValue={content.body}
        readOnly={!content.hasDoc}
        placeholder={content.hasDoc ? undefined : "No documentation yet."}
        onBlur={(e) => docNode && engine?.editNode(docNode.id, { docBody: e.target.value })}
      />
    </div>
  );
}

// --- References (S-11) -----------------------------------------------------------

function ReferencesPanel({ node }: { node: InspectorNode }) {
  const content = referencesContent(node);
  return (
    <div className="kv-inspector__fields">
      <div className="kv-inspector__field">
        <div className="kv-inspector__field-label">DECISIONS</div>
        <ul className="kv-inspector__list">
          {content.decisionLinks.map((link) => (
            <li key={link}>{link}</li>
          ))}
        </ul>
      </div>
      <div className="kv-inspector__field">
        <div className="kv-inspector__field-label">SCREENS</div>
        <ul className="kv-inspector__list">
          {content.screenLinks.map((link) => (
            <li key={link}>{link}</li>
          ))}
        </ul>
      </div>
      <Field label="INBOUND REFERENCES" value={String(content.inboundReferenceCount)} />
      {content.danglingReferences.length > 0 ? (
        <div className="kv-inspector__field">
          <div className="kv-inspector__field-label">DANGLING</div>
          <ul className="kv-inspector__list">
            {content.danglingReferences.map((link) => (
              <li key={link}>{link}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** PRD §12.9's `CANVAS PROPERTIES` empty state and derived tech stack. Every
 *  number computed except the layout save time — no real timestamp exists
 *  yet this wave, so the wireframe's own literal `4m ago` is kept as a
 *  placeholder rather than invented precision. `[P]`, recorded in the Wave 5
 *  handoff. */
function CanvasProperties({ graph }: { graph: SchematicGraph }) {
  const services = countServices(graph);
  const edges = countEdges(graph);
  const depth = computeDepth(graph.nodes);
  return (
    <div className="kv-inspector kv-inspector--canvas-properties">
      <div className="kv-inspector__header">CANVAS PROPERTIES</div>
      <p className="kv-inspector__body">
        Nothing selected. The inspector shows canvas-level properties:{" "}
        {`${plural(services, "service")}, ${plural(edges, "dependency edge")}, containment depth ${depth}, layout saved 4m ago.`}
      </p>
      {graph.techStack && graph.techStack.length > 0 ? (
        <div className="kv-inspector__techstack">
          <div className="kv-inspector__header">DERIVED TECH STACK</div>
          <table className="kv-inspector__techstack-table">
            <tbody>
              {graph.techStack.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td>
                    {row.version} · {row.license}
                  </td>
                  <td>{row.moduleCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="kv-inspector__footer">
            Read-only. Derived from per-module allowed_libraries against the registry.
          </p>
        </div>
      ) : null}
    </div>
  );
}
