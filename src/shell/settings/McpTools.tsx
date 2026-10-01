/**
 * The tools a server offers, drawn the way an MCP client's own panel draws them:
 * name, what it does, and the signature read off its input schema.
 *
 * The data is `mcpCatalog`, built in Rust from the registry that `tools/list`
 * is served from, so nothing here is a second description of a tool. The
 * `agent` server's `app_call` additionally lists every app method it can reach;
 * those have no parameter schemas, and the panel says so rather than drawing one.
 */
import { useId, useMemo, useState } from "react";
import type { McpAppMethodGroup, McpToolInfo } from "../../bindings";
import { describeSchema, firstSentence, signatureLine, type ParamRow } from "./mcpSignature";

/** The tool whose arguments name the app methods listed beneath it. */
const APP_CALL = "app_call";

function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  if (query === "") return true;
  return fields.some((f) => f?.toLowerCase().includes(query) === true);
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className="mcp-tools__chevron"
      data-open={open || undefined}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export default function McpTools({
  tools,
  appMethods,
  query = "",
}: {
  tools: McpToolInfo[];
  appMethods: McpAppMethodGroup[];
  /** The filter text. Typed in the title bar's search field, which `McpPanel`
   *  claims while a tool list is open, so this component draws no input. */
  query?: string;
}) {
  const needle = query.trim().toLowerCase();

  const shown = useMemo(
    () =>
      tools.filter((tool) => {
        if (matches(needle, tool.name, tool.description)) return true;
        return (
          tool.name === APP_CALL &&
          appMethods.some((g) => g.methods.some((m) => matches(needle, m.method, m.doc, g.name)))
        );
      }),
    [tools, appMethods, needle],
  );

  if (tools.length === 0) {
    return <p className="settings-mcp__empty">This server declares no tools.</p>;
  }

  return (
    <div className="mcp-tools">
      {shown.length === 0 ? (
        <p className="settings-mcp__empty" role="status">
          No tool matches &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <ul className="mcp-tools__list">
          {shown.map((tool) => (
            <ToolItem
              key={tool.name}
              tool={tool}
              groups={tool.name === APP_CALL ? appMethods : []}
              needle={needle}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ToolItem({
  tool,
  groups,
  needle,
}: {
  tool: McpToolInfo;
  groups: McpAppMethodGroup[];
  needle: string;
}) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const rows = useMemo(() => describeSchema(tool.inputSchema), [tool.inputSchema]);
  const hint = tool.annotations?.readOnlyHint;
  // A filter that matched only inside an app method has to show the methods.
  const expanded = open || (needle !== "" && groups.length > 0);

  return (
    <li className="mcp-tool">
      <button
        type="button"
        className="mcp-tool__head"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
      >
        <Chevron open={expanded} />
        <span className="mcp-tool__name">{tool.name}</span>
        {hint !== undefined && (
          <span className={`k-badge ${hint ? "k-badge--info" : "k-badge--warning"}`}>
            {hint ? "read-only" : "acts"}
          </span>
        )}
        {!expanded && <span className="mcp-tool__summary">{firstSentence(tool.description)}</span>}
      </button>

      {expanded && (
        <div className="mcp-tool__body" id={bodyId}>
          <p className="mcp-tool__description">{tool.description}</p>
          <code className="mcp-tool__signature">{signatureLine(tool.name, rows)}</code>

          {rows.length === 0 ? (
            <p className="mcp-tool__none">Takes no parameters.</p>
          ) : (
            <ParamList rows={rows} />
          )}

          <div className="mcp-tool__actions">
            <button
              type="button"
              className="mcp-tool__button"
              aria-pressed={raw}
              onClick={() => setRaw(!raw)}
            >
              Schema
            </button>
            {raw && <CopyButton text={JSON.stringify(tool.inputSchema, null, 2)} />}
          </div>
          {raw && (
            <pre className="mcp-tool__schema" tabIndex={0} aria-label={`${tool.name} input schema`}>
              {JSON.stringify(tool.inputSchema, null, 2)}
            </pre>
          )}

          {groups.length > 0 && <AppMethods groups={groups} needle={needle} />}
        </div>
      )}
    </li>
  );
}

function ParamList({ rows }: { rows: ParamRow[] }) {
  return (
    <ul className="mcp-params">
      {rows.map((row) => (
        <li key={row.name} className="mcp-param">
          <div className="mcp-param__line">
            <span className="mcp-param__name">{row.name}</span>
            <span className="mcp-param__type">{row.type}</span>
            <span className="mcp-param__req" data-required={row.required || undefined}>
              {row.required ? "required" : "optional"}
            </span>
            {row.defaultValue !== undefined && (
              <span className="mcp-param__default">default {row.defaultValue}</span>
            )}
          </div>
          {row.enumValues !== undefined && (
            <div className="mcp-param__enum">
              {row.enumValues.map((v) => (
                <code key={v} className="mcp-param__value">
                  {v}
                </code>
              ))}
            </div>
          )}
          {row.description !== undefined && <p className="mcp-param__desc">{row.description}</p>}
          {row.children.length > 0 && <ParamList rows={row.children} />}
        </li>
      ))}
    </ul>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    // Clipboard access can be refused (permissions, an unfocused window); the
    // label only changes when it worked, so a failure is not reported as a copy.
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch((err: unknown) => console.error("kaava: could not copy the schema:", err));
  };
  return (
    <button type="button" className="mcp-tool__button" onClick={copy}>
      {copied ? "Copied" : "Copy schema"}
    </button>
  );
}

function AppMethods({ groups, needle }: { groups: McpAppMethodGroup[]; needle: string }) {
  return (
    <section className="mcp-methods" aria-label="App methods reachable through app_call">
      <h4 className="mcp-methods__title">App methods</h4>
      <p className="mcp-tool__none">
        Pass one as <code>method</code>, with its app as <code>app</code>. Apps declare no parameter
        schemas, so no signatures are shown; the description is the handler&rsquo;s doc comment
        where it has one.
      </p>
      {groups.map((group) => {
        const methods = group.methods.filter((m) => matches(needle, m.method, m.doc, group.name));
        if (methods.length === 0) return null;
        return (
          <details key={group.app} className="mcp-group" open={needle !== "" || undefined}>
            <summary className="mcp-group__summary">
              <span className="mcp-group__name">{group.name}</span>
              <span className="mcp-group__count">
                <code>{group.app}/*</code> · {methods.length}
              </span>
            </summary>
            <ul className="mcp-group__list">
              {methods.map((m) => (
                <li key={m.method} className="mcp-method">
                  <div className="mcp-param__line">
                    <span className="mcp-param__name">{m.method}</span>
                    {m.write && <span className="k-badge k-badge--warning">writes</span>}
                    {m.blocked !== null && (
                      <span className="k-badge k-badge--danger">refused over MCP</span>
                    )}
                  </div>
                  <p className="mcp-param__desc">
                    {m.doc ?? "No doc comment, and no parameter schema is declared."}
                  </p>
                  {m.blocked !== null && <p className="mcp-param__desc">{m.blocked}</p>}
                </li>
              ))}
            </ul>
          </details>
        );
      })}
    </section>
  );
}
