import type { Body } from "./blocks";

/**
 * The MCP server manager, from the user's side.
 *
 * Deliberately blunt about the two things that will otherwise waste somebody's
 * afternoon: the servers that exist today are developer-mode only, and a terminal Veistra did not
 * spawn cannot connect at all — which looks exactly like a broken config.
 */
export const mcpServers: Body = {
  takeaway:
    "You can turn a Veistra MCP server on, get it into a project's `.mcp.json`, and connect an agent to it from a Veistra terminal.",
  blocks: [
    {
      kind: "text",
      body: "MCP — the Model Context Protocol — is how a coding agent picks up tools it did not ship with. Veistra hosts its own servers, so an agent working in your project can call into the parts of Veistra you would otherwise have to drive by hand.",
    },
    {
      kind: "text",
      body: "The servers run **inside** Veistra, not inside the apps or the stack tools. That matters: it explains why this works at all today. A tool's core is a separate process. The broker that would reach it has not been written, so a server hosted inside a tool's own repository would be stuck behind that gap. Hosted here, it isn't.",
    },
    {
      kind: "text",
      body: "Veistra hosts servers rather than acting as an agent harness that consumes them. You bring your own — Veistra's job is to give it tools and a terminal it can reach them from.",
    },
    {
      kind: "note",
      body: "One rule decides what gets a server: **if your agent can already do it, it does not get one**. No reading files, no writing them, no search, no git — every agent has those already. Only things that exist *inside Veistra and nowhere else* qualify, which is why the list is short and will stay short.",
    },
    {
      kind: "flow",
      steps: ["Turn on a server", "Lands in `.mcp.json`", "Connect an agent from a terminal"],
    },

    { kind: "heading", body: "Turn one on" },
    {
      kind: "step",
      body: "Press `Ctrl+,` to open Settings, and pick **MCP servers** from the list of sections.",
    },
    {
      kind: "step",
      body: "Turn on **developer mode** (Settings, Developer). Echo and Debug are developer servers, like UI and Agent: they stay out of the list, and out of `.mcp.json`, until it is on.",
    },
    {
      kind: "step",
      body: "Toggle the server you want. Each developer server starts off, so switch it on yourself. Each registered server is its own endpoint and its own entry in a project's config, so this is a per-server decision rather than one switch for the lot.",
    },
    {
      kind: "step",
      body: "Leave **Write .mcp.json into open projects** on. That is the switch that gets the server into a file your agent will actually read.",
    },
    {
      kind: "soon",
      body: "The servers you can turn on today are all developer servers. **Echo** has a `ping` and an `echo` tool and exists to prove the transport end to end. **Debug** reads the running shell: its layout, recent failures and boot status. Schematify's is the first real one, and it is not written yet.",
    },

    { kind: "heading", body: "What lands in your project" },
    {
      kind: "mock",
      view: "mcp-toggle",
      caption: "Turning Echo on writes `veistra-echo` into the project's `.mcp.json`.",
    },
    {
      kind: "text",
      body: "A `.mcp.json` at the project root, holding one entry per enabled server. Veistra **merges** rather than overwrites. If the project already has servers of its own, they are left exactly as they were — only the `veistra-` prefixed keys are Veistra's to write or remove.",
    },
    {
      kind: "code",
      body: `{
  "mcpServers": {
    "veistra-echo": {
      "type": "http",
      "url": "http://127.0.0.1:\${VEISTRA_MCP_PORT}/mcp/echo",
      "headers": { "Authorization": "Bearer \${VEISTRA_MCP_TOKEN}" }
    }
  }
}`,
    },
    {
      kind: "text",
      body: "Note what is **not** in there: no port number and no token. Both are environment variables, and that buys three things. The file is safe to commit, the token can rotate on every launch without rewriting anything on disk, and the entry is the same for everybody on the project.",
    },

    { kind: "heading", body: "The part that catches people" },
    {
      kind: "text",
      body: "Those two variables are set by **Veistra**, on the shells Veistra spawns. A terminal you opened outside Veistra inherits neither, so the URL does not resolve and the bearer token is empty.",
    },
    {
      kind: "note",
      body: 'That is the correct failure rather than an inconvenience. These tools reach into the running application; a shell opened outside it should not be able to. But it does mean the fix for "my agent cannot see the Veistra tools" is almost always **run the agent from a terminal inside Veistra** — see the Terminals tutorial.',
    },

    { kind: "heading", body: "Connecting an agent" },
    {
      kind: "step",
      body: "Open a terminal in the cluster your project is open in.",
    },
    {
      kind: "step",
      body: "Start your agent there — Claude Code, or any other MCP client that reads a project-scoped `.mcp.json`.",
    },
    {
      kind: "step",
      body: "Approve the server when the client asks. A project-scoped `.mcp.json` is approved once, interactively, on first use. That is a security feature of the client and Veistra does not try to defeat it silently.",
    },
    {
      kind: "text",
      body: "Tool names arrive namespaced by the server they came from — `mcp__veistra-echo__ping` — because each server is its own endpoint rather than everything being flattened behind one. That also means an agent working on one part of the stack can be given only that part's tools, instead of every tool Veistra has.",
    },

    { kind: "heading", body: "Security, in one paragraph" },
    {
      kind: "text",
      body: "The listener binds to `127.0.0.1` and never to `0.0.0.0` — a local channel that happens to speak HTTP. Putting it on a routable interface would put every registered tool on the network. Every request carries a bearer token minted for this launch.",
    },
    {
      kind: "soon",
      body: "Three pieces are designed but not built. The status bar indicator would tell you a server is connected, off, or waiting on your approval. The opt-in would pre-approve Veistra's own servers for a project. The notification would tell a connected client that the server list changed. Until the first of those lands, a server waiting on approval and a server that is off look the same from Veistra's side.",
    },
  ],
};
