/**
 * Claude Code's transcript JSONL, read into what the pane draws.
 *
 * The format is Claude Code's own and undocumented, so this reads only what it
 * needs and keeps anything else as an opaque line. A new line type shows up
 * as "other", not as a crash or a silent gap.
 */

export type Entry =
  | { kind: "user"; text: string; at: string | null }
  | { kind: "assistant"; text: string; at: string | null }
  | {
      kind: "tool";
      id: string;
      name: string;
      /** One line: the command, the path, or the pattern the tool was given. */
      summary: string;
      input: unknown;
      /** `null` until the matching `tool_result` line arrives. */
      result: string | null;
      isError: boolean;
      at: string | null;
    }
  | { kind: "system"; text: string; at: string | null }
  | { kind: "other"; type: string; raw: string };

export interface Parsed {
  entries: Entry[];
  /** Claude Code's own one-line title for the session, when it wrote one. */
  summary: string | null;
  /** Lines that were not JSON at all. */
  unreadable: number;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function parseTranscript(text: string): Parsed {
  const entries: Entry[] = [];
  const tools = new Map<string, Extract<Entry, { kind: "tool" }>>();
  let summary: string | null = null;
  let unreadable = 0;

  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      unreadable++;
      continue;
    }
    if (!isObject(line)) {
      unreadable++;
      continue;
    }
    const type = str(line.type) ?? "unknown";
    const at = str(line.timestamp);
    const message = isObject(line.message) ? line.message : null;

    if (type === "summary") {
      summary = str(line.summary) ?? summary;
    } else if (type === "user" && message) {
      // Command caveats and other lines Claude Code injects for itself.
      if (line.isMeta === true) continue;
      const content = message.content;
      if (typeof content === "string") {
        entries.push({ kind: "user", text: content, at });
        continue;
      }
      for (const block of Array.isArray(content) ? content : []) {
        if (!isObject(block)) continue;
        if (block.type === "tool_result") {
          const tool = tools.get(str(block.tool_use_id) ?? "");
          if (tool) {
            tool.result = resultText(block.content);
            tool.isError = block.is_error === true;
          }
        } else if (block.type === "text" && str(block.text)) {
          entries.push({ kind: "user", text: block.text as string, at });
        }
      }
    } else if (type === "assistant" && message) {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isObject(block)) continue;
        if (block.type === "text" && str(block.text)?.trim()) {
          entries.push({ kind: "assistant", text: block.text as string, at });
        } else if (block.type === "tool_use") {
          const tool: Extract<Entry, { kind: "tool" }> = {
            kind: "tool",
            id: str(block.id) ?? "",
            name: str(block.name) ?? "tool",
            summary: toolSummary(block.input),
            input: block.input,
            result: null,
            isError: false,
            at,
          };
          tools.set(tool.id, tool);
          entries.push(tool);
        }
        // `thinking` blocks are left out: they are long and rarely what a
        // person checking on an agent wants to read.
      }
    } else if (type === "system") {
      const text = str(line.content);
      if (text) entries.push({ kind: "system", text, at });
    } else {
      entries.push({ kind: "other", type, raw });
    }
  }
  return { entries, summary, unreadable };
}

/** The first thing a person asked, which titles a session once `prompt` is gone. */
export function firstRequest(parsed: Parsed): string | null {
  const first = parsed.entries.find((e) => e.kind === "user");
  return first?.kind === "user" ? first.text : null;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObject(c) && typeof c.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

const SUMMARY_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "description"];

function toolSummary(input: unknown): string {
  if (!isObject(input)) return "";
  for (const key of SUMMARY_KEYS) {
    const value = str(input[key]);
    if (value) return value.split("\n")[0];
  }
  const json = JSON.stringify(input);
  return json.length > 120 ? `${json.slice(0, 119)}…` : json;
}
