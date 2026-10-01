// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import McpTools from "./McpTools";
import type { McpAppMethodGroup, McpToolInfo } from "../../bindings";

const TOOLS: McpToolInfo[] = [
  {
    name: "echo",
    description: "Returns the message. It is unchanged.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "Any text." } },
      required: ["message"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "app_call",
    description: "Call an app.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false },
  },
];

const METHODS: McpAppMethodGroup[] = [
  {
    app: "files",
    name: "Files",
    methods: [
      { method: "files/read", write: false, doc: "Reads one file.", blocked: null },
      { method: "files/save-as", write: true, doc: null, blocked: "Raises a dialog." },
    ],
  },
];

afterEach(cleanup);

describe("McpTools", () => {
  it("shows the first sentence collapsed and the signature once expanded", () => {
    render(<McpTools serverName="Echo" tools={TOOLS} appMethods={[]} />);
    expect(screen.getByText("Returns the message.")).toBeTruthy();
    expect(screen.queryByText("echo(message: string)")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /echo/ }));
    expect(screen.getByText("echo(message: string)")).toBeTruthy();
    expect(screen.getByText("Any text.")).toBeTruthy();
    expect(screen.getByText("required")).toBeTruthy();
  });

  it("badges read-only and acting tools", () => {
    render(<McpTools serverName="Echo" tools={TOOLS} appMethods={[]} />);
    expect(screen.getByText("read-only")).toBeTruthy();
    expect(screen.getByText("acts")).toBeTruthy();
  });

  it("toggles the raw schema", () => {
    render(<McpTools serverName="Echo" tools={TOOLS} appMethods={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /echo/ }));
    fireEvent.click(screen.getByRole("button", { name: "Schema" }));
    expect(screen.getByLabelText("echo input schema").textContent).toContain('"message"');
    expect(screen.getByRole("button", { name: "Copy schema" })).toBeTruthy();
  });

  it("filters tools by name and description", () => {
    render(<McpTools serverName="Echo" tools={TOOLS} appMethods={[]} />);
    fireEvent.change(screen.getByLabelText("Filter Echo tools"), {
      target: { value: "unchanged" },
    });
    expect(screen.queryByText("app_call")).toBeNull();
    expect(screen.getByText("echo")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter Echo tools"), { target: { value: "zzz" } });
    expect(screen.getByRole("status").textContent).toContain("No tool matches");
  });

  it("lists app methods under app_call and says there are no signatures", () => {
    render(<McpTools serverName="Agent" tools={TOOLS} appMethods={METHODS} />);
    fireEvent.click(screen.getByRole("button", { name: /app_call/ }));
    expect(screen.getByText(/no parameter\s+schemas/)).toBeTruthy();
    fireEvent.click(screen.getByText("Files"));
    expect(screen.getByText("Reads one file.")).toBeTruthy();
    expect(screen.getByText("writes")).toBeTruthy();
    expect(screen.getByText("refused over MCP")).toBeTruthy();
    expect(screen.getByText(/No doc comment/)).toBeTruthy();
  });

  it("finds an app method through the filter", () => {
    render(<McpTools serverName="Agent" tools={TOOLS} appMethods={METHODS} />);
    fireEvent.change(screen.getByLabelText("Filter Agent tools"), { target: { value: "save-as" } });
    expect(screen.getByText("files/save-as")).toBeTruthy();
    expect(screen.queryByText("files/read")).toBeNull();
  });
});
