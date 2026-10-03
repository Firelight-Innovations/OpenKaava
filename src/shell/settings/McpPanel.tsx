/**
 * The MCP servers OpenKaava hosts, with a switch on each.
 *
 * ## Panels are the exception, and should stay one
 *
 * Every other section is drawn entirely from the schema: Rust declares a key, a
 * control and a default, and `ControlFor` draws it. That is what makes adding a
 * setting a Rust-only edit, and it is worth more than any section's look.
 *
 * The server list cannot be expressed that way. It is not a key holding a value
 * — it is a list the registry owns, each row of which has a name, a route, a
 * config key, a tool count, and its own switch. Fitting it into the schema would
 * mean inventing a `Control` that renders a list of things with per-row state,
 * which no other section could use and which would put the registry's shape into
 * a type that is supposed to be about values. So the exception is drawn here, in
 * one file, next to the section it belongs to.
 *
 * The other is `CloudAccountPanel.tsx`, for credentials. A third section wanting
 * a panel means the schema is missing a control, not that panels are the way.
 */
import { useEffect, useId, useRef, useState } from "react";
import McpTools from "./McpTools";
import { useTitlebarSearch } from "../titlebarSearch";
import ToggleControl from "./controls/ToggleControl";
import {
  mcpCatalog,
  mcpStatus,
  onSettingsChanged,
  setMcpServerEnabled,
  type McpCatalog,
  type McpServerInfo,
  type McpStatus,
} from "../../bindings";

export default function McpPanel() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  // Read on first expansion rather than at mount: building it scans the app
  // sources for method names, and most visits never open a row.
  const [catalog, setCatalog] = useState<McpCatalog | null>(null);
  const [wantCatalog, setWantCatalog] = useState(false);
  // How many servers have their tool list open, and the one filter they share.
  // The filter is typed in the title bar's search field: it is claimed here only
  // while a list is open, so it sits above the Settings search and gives it back
  // when the last list closes.
  const [openCount, setOpenCount] = useState(0);
  const [toolQuery, setToolQuery] = useState("");
  useTitlebarSearch(
    openCount > 0
      ? { placeholder: "Filter tools", value: toolQuery, onChange: setToolQuery }
      : null,
  );

  useEffect(() => {
    if (!wantCatalog) return;
    let live = true;
    const load = () =>
      mcpCatalog()
        .then((next) => {
          if (live) setCatalog(next);
        })
        .catch((err: unknown) => console.error("kaava: could not read the MCP tools:", err));
    void load();
    // Developer mode changes which servers exist, so the tools follow it.
    const subscription = onSettingsChanged(() => void load());
    return () => {
      live = false;
      void subscription.then((unlisten) => {
        unlisten();
      });
    };
  }, [wantCatalog]);

  // Fetched here rather than by `useSettings`, which is the settings *store* and
  // holds none of this: the servers live in the MCP registry and the port
  // belongs to a listener, so neither appears in `settings.json`. Folding them
  // in would give every window a subscription to something only this panel
  // reads, in the one section most windows never open.
  useEffect(() => {
    let live = true;
    const apply = (next: McpStatus | null) => {
      if (live && next !== null) setStatus(next);
    };

    void refresh().then(apply);

    // Re-read on any settings change, because one of them decides what this
    // list contains: `developer.mode` reveals servers, and Rust filters them out
    // of `mcpStatus` rather than sending them down to be hidden here. Without
    // this the switch would appear to do nothing until the screen was reopened,
    // which is the exact failure `Applies::Now` promises it will not be.
    //
    // Any change rather than that one key: the payload is the whole values map,
    // a re-fetch is one cheap call, and matching on a key would put the name of
    // a Rust constant in a second place that has to agree with it.
    const subscription = onSettingsChanged(() => {
      void refresh().then(apply);
    });

    return () => {
      live = false;
      void subscription.then((unlisten) => {
        unlisten();
      });
    };
  }, []);

  const toggle = (server: McpServerInfo, next: boolean) => {
    // Optimistic, the same shape `useSettings.set` uses and for the same reason:
    // a switch that repaints a round trip after the click reads as a click that
    // missed. The re-fetch below is the reconcile — Rust rewrites every open
    // project's `.mcp.json` on the way out, and it is the authority on what the
    // row now says, including its tool count.
    setStatus((current) =>
      current === null
        ? current
        : {
            ...current,
            servers: current.servers.map((s) => (s.id === server.id ? { ...s, enabled: next } : s)),
          },
    );

    void setMcpServerEnabled(server.id, next)
      .catch((err: unknown) => console.error("kaava: could not switch an MCP server:", err))
      .then(refresh)
      .then((fresh) => {
        // Runs after a failure too, which is the point: the optimistic flip
        // above is a guess, and a refused write has to be taken back off the
        // screen rather than left sitting there looking applied.
        if (fresh !== null) setStatus(fresh);
      });
  };

  if (status === null) return null;

  return (
    <section className="settings-mcp" aria-label="MCP servers">
      <Endpoint port={status.port} />

      {status.servers.length === 0 ? (
        <p className="settings-mcp__empty">
          This build hosts no MCP servers. What one is, and the rule about what may be added, are in{" "}
          <span className="settings-mcp__path">docs/mcp-server-manager.md</span>.
        </p>
      ) : (
        status.servers.map((server) => (
          <ServerRow
            key={server.id}
            server={server}
            onToggle={toggle}
            catalog={catalog}
            onOpen={() => setWantCatalog(true)}
            onOpenChange={(now) => setOpenCount((n) => n + (now ? 1 : -1))}
            query={toolQuery}
          />
        ))
      )}
    </section>
  );
}

/**
 * Where a client would connect, or why it could not.
 *
 * A null port means the listener never bound — a machine that would not hand out
 * a loopback socket. Every switch below is still meaningful (they persist), but
 * nothing is reachable, and drawing the ordinary "listening" line over that
 * would send somebody looking for the fault in their agent's config.
 */
function Endpoint({ port }: { port: number | null }) {
  const reachable = port !== null;
  return (
    <p className="settings-mcp__endpoint">
      <span className={`k-badge ${reachable ? "k-badge--success" : "k-badge--danger"}`}>
        <span className="k-badge__dot" />
        {reachable ? "Listening" : "Not listening"}
      </span>
      {reachable ? (
        <span className="settings-mcp__path">127.0.0.1:{port}</span>
      ) : (
        <span>The listener did not start, so no server is reachable</span>
      )}
    </p>
  );
}

/** One server: what it is, how to reach it, and whether it is on. */
function ServerRow({
  server,
  onToggle,
  catalog,
  onOpen,
  onOpenChange,
  query,
}: {
  server: McpServerInfo;
  onToggle: (server: McpServerInfo, next: boolean) => void;
  catalog: McpCatalog | null;
  onOpen: () => void;
  onOpenChange: (open: boolean) => void;
  query: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const tools = catalog?.servers.find((s) => s.id === server.id)?.tools;
  const flip = () => {
    if (!open) onOpen();
    setOpen(!open);
    onOpenChange(!open);
  };

  // A row that unmounts while open (the section changed, or Settings closed)
  // must give its count back, or the claim would outlive the lists.
  const openRef = useRef(false);
  openRef.current = open;
  useEffect(
    () => () => {
      if (openRef.current) onOpenChange(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount only
    [],
  );

  return (
    <div className="settings-mcp__server">
      <div className="setting">
        <div className="setting__label">
          <span className="setting__title">
            {server.name}
            {/* Marked rather than merely present. Reaching this row took a
              deliberate switch in another section, and by the time somebody has
              scrolled to it that is easy to have forgotten — so the row says
              what it is at the moment the switch beside it is being considered. */}
            {server.devOnly && (
              <span className="k-badge k-badge--idle">
                <span className="k-badge__dot" />
                developer
              </span>
            )}
          </span>
          <span className="setting__description">{server.description}</span>
          {/* The config key and the route, in mono because both are things you
            retype into somewhere else — a project's `.mcp.json` and a browser
            respectively. The tool count rides along on the same line: it is the
            one number that says whether switching this on is worth anything. */}
          <span className="settings-mcp__meta">
            {server.configKey} · {server.path} ·{" "}
            <button
              type="button"
              className="settings-mcp__expand"
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={`${open ? "Hide" : "Show"} the tools of ${server.name}`}
              onClick={flip}
            >
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
              {toolCount(server.toolCount)}
            </button>
          </span>
        </div>
        <div className="setting__control">
          <ToggleControl
            on={server.enabled}
            label={server.name}
            onChange={(next) => onToggle(server, next)}
          />
        </div>
        <div className="setting__reset-slot" />
      </div>
      {open && (
        <div className="settings-mcp__tools" id={panelId}>
          {tools === undefined ? (
            <p className="settings-mcp__empty" role="status">
              Reading the tools&hellip;
            </p>
          ) : (
            <McpTools
              tools={tools}
              query={query}
              appMethods={server.id === "agent" ? (catalog?.appMethods ?? []) : []}
            />
          )}
        </div>
      )}
    </div>
  );
}

function toolCount(count: number): string {
  return count === 1 ? "1 tool" : `${count} tools`;
}

/**
 * Read the status, or `null` if it could not be read.
 *
 * Swallowing rather than surfacing: the panel's own failure mode is that it
 * keeps showing what it last knew, which is strictly better than replacing a
 * working list with an error. The console line is there because the symptom —
 * a switch that snaps back — is otherwise unattributable.
 */
function refresh(): Promise<McpStatus | null> {
  return mcpStatus().catch((err: unknown) => {
    console.error("kaava: could not read the MCP status:", err);
    return null;
  });
}
