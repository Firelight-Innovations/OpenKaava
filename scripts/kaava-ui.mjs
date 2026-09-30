/**
 * An agent-owned OpenKaava, started and ready to be driven.
 *
 * Usage:
 *   pnpm ui:build     build it, once (a release build, several minutes)
 *   pnpm ui launch    start it, with developer mode and the UI server on
 *   pnpm ui close     stop it, and only it
 *
 * Then drive it through the server it is hosting:
 *   pnpm probe --agent --server ui screenshot
 *   pnpm probe --agent --server ui snapshot
 *   pnpm probe --agent --server ui click '{"target":"e12"}'
 *
 * This used to open a WebView2 debug port and implement snapshot, click and type
 * out here. All of that is `src-tauri/src/mcp/servers/ui.rs` now. What is left is
 * the one thing a server inside OpenKaava cannot do for itself: exist.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

/**
 * The identifier `pnpm ui:build` compiles this binary under.
 *
 * `tauri-plugin-single-instance` keys its mutex on `{identifier}-sim`, so a
 * second launch under the user's identifier would hand its argv to their window
 * and exit — and anything that then "cleaned up its own instance" would close
 * theirs. Every store also resolves through `app_config_dir()`, which derives
 * from the same field, so this one override buys both a second process and a
 * private `%APPDATA%` tree.
 */
const IDENTIFIER = "com.firelightinnovations.openkaava.agent";

/** The built binary, honouring `CARGO_TARGET_DIR` if the worktree shares one. */
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? join(process.cwd(), "target");
const EXE = join(TARGET_DIR, "release", "openkaava-orchestrator.exe");

function note(message) {
  process.stderr.write(`kaava-ui: ${message}\n`);
}

function die(message) {
  note(message);
  process.exitCode = 1;
}

/** The agent instance's config directory. Never the user's — see `IDENTIFIER`. */
function configDir() {
  const roaming = process.env.APPDATA;
  if (!roaming) throw new Error("APPDATA is not set, so the config directory cannot be found");
  return join(roaming, IDENTIFIER);
}

/** One of OpenKaava's config files, or `{}` if it has not written one yet. */
function read(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Switch on developer mode and the agent server, before the first launch.
 *
 * Written rather than clicked, because of a chicken and egg: the server is what
 * an agent would use to click the switch, and the switch is what turns the
 * server on. Both files are OpenKaava's own, in the format it writes them, and
 * both are merged rather than replaced so a second `launch` keeps whatever the
 * instance has learned since the first.
 *
 * This touches the agent identifier's directory and nothing else. An OpenKaava
 * somebody started keeps its settings in a different folder under a different
 * identifier, and nothing here can reach them.
 */
function enable() {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });

  const settingsPath = join(dir, "settings.json");
  const settings = read(settingsPath);
  settings.values = { ...settings.values, "developer.mode": true };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  // Both, deliberately. `agent` is what these scripts point at now, and it
  // hosts `ui`'s six tools by delegation — but `ui` costs nothing to leave on
  // and is what an older handoff or a half-remembered command line asks for. A
  // launch that answers both spellings is worth the second key.
  const mcpPath = join(dir, "mcp.json");
  const mcp = read(mcpPath);
  // `debug` and `echo` are developer-only too, and `pnpm probe` defaults to
  // `debug`, so `pnpm probe --agent` needs it on as much as `agent` is.
  mcp.switched = { ...mcp.switched, ui: true, agent: true, debug: true, echo: true };
  writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);

  note(`developer mode and the agent, debug and echo servers switched on in ${dir}`);
}

function launch() {
  if (!existsSync(EXE)) {
    return die(
      `no binary at ${EXE}.\n` +
        "           Build one with `pnpm ui:build`, which sets the agent identifier so this\n" +
        "           instance can run beside an OpenKaava you started yourself.",
    );
  }

  enable();

  const child = spawn(EXE, [], { detached: true, stdio: "ignore" });
  child.unref();

  note(`launched ${EXE}`);
  note("give it a few seconds, then: pnpm probe --agent --server agent screenshot");
}

/**
 * Stop the agent instance, by pid.
 *
 * By pid and not by image name, which is what this used to do: the user's
 * OpenKaava runs from a binary with the same name, and `taskkill /IM` would have taken it
 * down alongside. The pid comes from the endpoint file the instance itself
 * wrote, which is per-identifier and therefore already the right process.
 */
async function close() {
  const endpoint = read(join(configDir(), "mcp-endpoint.json"));
  if (!endpoint.pid) return note("no agent instance has recorded itself as running");

  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("taskkill", ["/PID", String(endpoint.pid), "/F"], { stdio: "ignore" });
    note(`stopped pid ${endpoint.pid}`);
  } catch {
    note(`pid ${endpoint.pid} was already gone`);
  }
}

const HELP = `kaava-ui — an agent-owned OpenKaava to drive

  launch    start one, with developer mode and the agent server switched on
  close     stop it, by pid, leaving anyone else's OpenKaava alone

Driving it is \`pnpm probe --agent --server agent <tool>\`:

  screenshot                          a PNG, written to the OS temp dir (path printed)
  snapshot                            what can be clicked, with refs
  click '{"target":"e12"}'
  type_text '{"text":"hello"}'
  press_key '{"key":"Enter"}'
  eval '{"expression":"document.title"}'

  shell_snapshot                      windows, clusters, panes, instances
  recent_errors                       what has failed since launch
  boot_status                         how far startup got

  set_project '{"path":"C:\\path\\to\\project"}'
  open_app '{"appId":"schematify"}'
  app_call '{"app":"schematify","method":"schematify/lint","params":{"actor":"agent"}}'
`;

async function main() {
  const command = process.argv[2];

  if (command === "launch") return launch();
  if (command === "close") return close();
  if (!command || command === "help") return void process.stdout.write(HELP);

  die(`unknown command ${JSON.stringify(command)}. Try \`pnpm ui help\`.`);
}

main().catch((e) => die(e.stack ?? String(e)));
