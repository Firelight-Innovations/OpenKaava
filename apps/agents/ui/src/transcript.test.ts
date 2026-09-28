import { describe, expect, it } from "vitest";
import { firstRequest, parseTranscript } from "./transcript";
import fixture from "../../../../src-tauri/fixtures/cloud/veistra-prod-sessions/kaava-worker/3f2a9c1e-7b40-4d2a-9e61-0c5d8b7a1f01/transcript.jsonl?raw";

const lines = (...objects: unknown[]): string => objects.map((o) => JSON.stringify(o)).join("\n");

describe("parseTranscript", () => {
  it("pairs a tool result with the call that asked for it", () => {
    const parsed = parseTranscript(
      lines(
        { type: "user", message: { role: "user", content: "List files" } },
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Listing." },
              { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls\n-la" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "t1", content: "a\nb", is_error: true }],
          },
        },
      ),
    );
    expect(parsed.entries.map((e) => e.kind)).toEqual(["user", "assistant", "tool"]);
    const tool = parsed.entries[2];
    expect(tool.kind === "tool" && tool.summary).toBe("ls");
    expect(tool.kind === "tool" && tool.result).toBe("a\nb");
    expect(tool.kind === "tool" && tool.isError).toBe(true);
  });

  it("keeps an unknown line type as opaque and counts garbage", () => {
    const parsed = parseTranscript(`${lines({ type: "some-future-type", x: 1 })}\nnot json\n`);
    expect(parsed.entries).toEqual([
      {
        kind: "other",
        type: "some-future-type",
        raw: '{"type":"some-future-type","x":1}',
      },
    ]);
    expect(parsed.unreadable).toBe(1);
  });

  it("drops Claude Code's bookkeeping lines rather than drawing empty rows", () => {
    const parsed = parseTranscript(
      lines(
        { type: "file-history-snapshot", snapshot: {} },
        { type: "attachment", attachment: { type: "todo" } },
        { type: "last-prompt", lastPrompt: "x" },
        { type: "atis-latch", latched: true },
        { type: "cost-state", costUSD: 0.1 },
        { type: "queue-operation", operation: "enqueue" },
        { type: "user", message: { role: "user", content: "Hello" } },
      ),
    );
    expect(parsed.entries.map((e) => e.kind)).toEqual(["user"]);
  });

  it("skips meta lines and thinking blocks", () => {
    const parsed = parseTranscript(
      lines(
        { type: "user", isMeta: true, message: { content: "<caveat>" } },
        { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } },
      ),
    );
    expect(parsed.entries).toEqual([]);
  });

  it("reads the committed fixture: a title, a first request, and every tool answered", () => {
    const parsed = parseTranscript(fixture);
    expect(parsed.unreadable).toBe(0);
    expect(parsed.summary).toBe("Model chair-test v2 from feedback");
    expect(firstRequest(parsed)).toMatch(/^Build the chair/);
    const tools = parsed.entries.filter((e) => e.kind === "tool");
    expect(tools.length).toBe(3);
    expect(tools.every((t) => t.kind === "tool" && t.result !== null)).toBe(true);
  });
});
