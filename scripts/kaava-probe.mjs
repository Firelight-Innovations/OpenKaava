/**
 * Ask a running OpenKaava what it is doing, from outside it.
 *
 * Usage:
 *   node scripts/kaava-probe.mjs                     list the debug tools
 *   node scripts/kaava-probe.mjs shell_snapshot
 *   node scripts/kaava-probe.mjs recent_errors '{"after":12}'
 *   node scripts/kaava-probe.mjs --agent --server agent click '{"target":"e12"}'
 *   node scripts/kaava-probe.mjs --agent --server agent app_call \
 *     '{"app":"schematify","method":"schematify/lint","params":{"actor":"agent"}}'
 *
 * `--server agent` is the one to reach for while working on OpenKaava; `ui` and
 * `debug` host subsets of it. Prints the tool's JSON on stdout and nothing else,
 * so it pipes into `jq`; explanation goes to stderr, and an image answer goes to
 * a PNG in the OS temp dir (not this repo) whose path is printed to both.
 *
 * The endpoint speaks MCP over streamable HTTP — a three-step handshake and a
 * session header, silently wrong under `curl` unless you get all of it right.
 * `docs/design-notes/agent-debugging.md` covers how the port and token are found.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Matches `tauri::path::app_config_dir` on Windows, and the identifier in
 * tauri.conf.json.
 *
 * A different identifier is a different config directory, and therefore a
 * different endpoint file. `--agent` picks the one `pnpm ui:build` compiles, so
 * an agent testing a change talks to its own instance rather than to an
 * OpenKaava somebody is using. `KAAVA_IDENTIFIER` covers anything else.
 */
const IDENTIFIER = process.env.KAAVA_IDENTIFIER || "com.firelightinnovations.openkaava";
const AGENT_IDENTIFIER = process.env.KAAVA_IDENTIFIER || "com.firelightinnovations.openkaava.agent";

/** Which one this run is talking to. `--agent` moves it; nothing else does. */
let identifier = IDENTIFIER;
const ENDPOINT_FILE = "mcp-endpoint.json";

/** The version this client claims to speak. Rejected outright if the server disagrees. */
const PROTOCOL_VERSION = "2025-06-18";

/**
 * Thrown by [`die`] to unwind, rather than exiting where it stands.
 *
 * `process.exit` here tore down an HTTP socket that was still open and printed
 * a libuv assertion after the message — noise on exactly the path somebody is
 * already reading carefully, and easy to mistake for part of the failure.
 */
class Bail extends Error {}

function die(message) {
  process.stderr.write(`kaava-probe: ${message}\n`);
  process.exitCode = 1;
  throw new Bail(message);
}

/**
 * Where `mcp::handoff` wrote the endpoint.
 *
 * `APPDATA` rather than a computed home path: it is what Tauri resolves
 * `app_config_dir` to on Windows, and honouring the variable means a machine
 * with a redirected profile still lands in the right place.
 */
function endpointPath() {
  const roaming = process.env.APPDATA;
  if (!roaming) die("APPDATA is not set, so the config directory cannot be found");
  return join(roaming, identifier, ENDPOINT_FILE);
}

/**
 * Read the endpoint, and refuse a stale one.
 *
 * The pid check is the whole reason the file carries one. Nothing deletes this
 * file on exit, so a file left by an OpenKaava that is no longer running would
 * otherwise send every request to a port that is closed, or — worse — to
 * whatever took the port afterwards.
 */
function readEndpoint() {
  const path = endpointPath();

  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") {
      die(`no endpoint file at ${path}. Is OpenKaava running?`);
    }
    die(`could not read ${path}: ${e.message}`);
  }

  let endpoint;
  try {
    endpoint = JSON.parse(raw);
  } catch (e) {
    die(`${path} is not valid JSON: ${e.message}`);
  }

  if (!alive(endpoint.pid)) {
    die(`${path} names pid ${endpoint.pid}, which is not running. OpenKaava has exited.`);
  }

  return endpoint;
}

/**
 * Whether a pid is a live process.
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. `EPERM` means the process exists but belongs to someone else, which
 * for our purposes is still "alive" — and should not happen, since the file is
 * in this user's profile.
 */
function alive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/**
 * One JSON-RPC message to the server.
 *
 * `rmcp` answers either `application/json` or a one-event SSE stream depending
 * on the request, so both are accepted and both are unwrapped here. A caller
 * that only handled JSON would work until the day the server chose to stream.
 */
async function rpc(endpoint, server, body, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: endpoint.authorization ?? `Bearer ${endpoint.token}`,
    "MCP-Protocol-Version": PROTOCOL_VERSION,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const response = await fetch(`${endpoint.url}/mcp/${server}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    die(`${body.method} failed: HTTP ${response.status} ${response.statusText} ${detail}`.trim());
  }

  return {
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
    // A notification is answered with 202 and an empty body; there is nothing
    // to parse and nothing that wants one.
    message: response.status === 202 ? null : parseBody(await response.text(), response),
  };
}

/**
 * Unwrap either a bare JSON body or the payload of an SSE stream.
 *
 * The stream opens with an empty keep-alive event — `data:` with nothing after
 * it, carrying only the `retry` interval — so the first `data:` line is not the
 * answer. Every one of them is scanned and the first that is non-empty wins.
 */
function parseBody(text, response) {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream")) return JSON.parse(text);

  const payloads = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean);

  if (payloads.length === 0) die("the server sent an event stream with no data in it");

  return JSON.parse(payloads[0]);
}

/**
 * `initialize`, then the `initialized` notification the spec requires before any
 * other request. Skipping the second one leaves `rmcp` refusing everything after
 * it with an error that does not say why.
 */
async function connect(endpoint, server) {
  const opened = await rpc(endpoint, server, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "kaava-probe", version: "1" },
    },
  });

  if (opened.message?.error) die(`initialize was refused: ${opened.message.error.message}`);

  await rpc(
    endpoint,
    server,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    opened.sessionId,
  );

  return opened.sessionId;
}

/**
 * What to add when a server answers as if it were not there.
 *
 * `debug`, `echo`, `ui` and `agent` are all developer-only: they are absent, not
 * merely off, until `developer.mode` is on and the server's own switch in
 * Settings -> MCP servers is on too. `pnpm ui launch` does both for the agent's
 * own instance, which is what `--agent` reaches.
 */
function notServedHint(server) {
  return ` If OpenKaava is not serving \`${server}\`, turn on developer mode (Settings -> Developer) and switch the ${server} server on under Settings -> MCP servers. An instance from \`pnpm ui launch\` has both already; use --agent to reach it.`;
}

async function main() {
  const args = process.argv.slice(2);

  const agentAt = args.indexOf("--agent");
  if (agentAt !== -1) {
    identifier = AGENT_IDENTIFIER;
    args.splice(agentAt, 1);
  }

  let server = "debug";
  const serverAt = args.indexOf("--server");
  if (serverAt !== -1) {
    server = args[serverAt + 1];
    if (!server) die("--server needs a server id");
    args.splice(serverAt, 2);
  }

  const [tool, rawParams] = args;

  // `@path` reads the parameters from a file, and `-` from stdin. A long
  // add-shapes spec or a value with quotes and braces does not survive
  // Windows command-line quoting, and `pnpm probe` goes through cmd.exe.
  let params = {};
  if (rawParams) {
    let text = rawParams;
    try {
      if (rawParams === "-") text = readFileSync(0, "utf8");
      else if (rawParams.startsWith("@")) text = readFileSync(rawParams.slice(1), "utf8");
    } catch (e) {
      die(`could not read the parameters from ${rawParams}: ${e.message}`);
    }
    try {
      params = JSON.parse(text);
    } catch (e) {
      die(`the parameters are not valid JSON: ${e.message}`);
    }
  }

  const endpoint = readEndpoint();
  process.stderr.write(`kaava-probe: ${endpoint.url}/mcp/${server} (pid ${endpoint.pid})\n`);

  const sessionId = await connect(endpoint, server);

  const request = tool
    ? { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: params } }
    : { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

  const { message } = await rpc(endpoint, server, request, sessionId);

  if (message?.error)
    die(`${request.method} failed: ${message.error.message}${notServedHint(server)}`);

  if (!tool && message?.result?.tools?.length === 0) {
    die(`the ${server} server lists no tools.${notServedHint(server)}`);
  }

  // A tool that fails answers with `isError` and its reason as content rather
  // than with a JSON-RPC error, so a caller checking only for `error` would read
  // a failure as a result.
  if (message?.result?.isError) {
    const reason = JSON.stringify(message.result.content);
    die(
      `${tool} reported an error: ${reason}${/no MCP server/i.test(reason) ? notServedHint(server) : ""}`,
    );
  }

  const image = message?.result?.content?.find((block) => block.type === "image");
  if (image) {
    const path = process.env.KAAVA_SHOT || join(tmpdir(), "kaava-shot.png");
    writeFileSync(path, Buffer.from(image.data, "base64"));
    process.stderr.write(`kaava-probe: screenshot written to ${path}\n`);
    process.stdout.write(`${path}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(unwrap(message.result), null, 2)}\n`);
}

/**
 * Pull the payload out of an MCP `tools/call` result.
 *
 * A result arrives as a list of content blocks with the JSON stringified inside
 * a text block. Handing that back raw would make every caller parse a string out
 * of an object out of a list, so it is parsed here — and returned untouched if
 * it turns out not to be JSON after all.
 */
function unwrap(result) {
  const text = result?.content?.find((block) => block.type === "text")?.text;
  if (typeof text !== "string") return result;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

main().catch((e) => {
  // A `Bail` has already said what went wrong and set the exit code.
  if (e instanceof Bail) return;
  process.stderr.write(`kaava-probe: ${e.stack ?? String(e)}\n`);
  process.exitCode = 1;
});
