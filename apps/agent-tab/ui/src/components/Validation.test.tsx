// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Item, ToolStatus } from "../protocol.generated";
import { latestValidation, lintReportOf } from "../validation";
import { defaultSlots } from "./registry";

afterEach(cleanup);

const REPORT = {
  kind: "canvasLint",
  pass: false,
  failedChecks: ["outside_frame"],
  checks: [
    {
      id: "frame_unnamed",
      label: "Every frame has a specific name",
      pass: true,
      warn: false,
      hard: true,
      count: 0,
      issues: [],
    },
    {
      id: "outside_frame",
      label: "Every element is inside a frame",
      pass: false,
      warn: false,
      hard: true,
      count: 4,
      issues: ["a rectangle", "b text", "c arrow", "d line"],
    },
  ],
  stats: {},
};

describe("the canvas validation card", () => {
  it("reads the report from lint_canvas and from add_shapes' validation", () => {
    expect(lintReportOf(JSON.stringify(REPORT))?.failedChecks).toEqual(["outside_frame"]);
    const added = `Result:\n${JSON.stringify({ canvas: "game", validation: REPORT })}`;
    expect(lintReportOf(added)?.checks).toHaveLength(2);
    expect(lintReportOf('{"kind":"canvasLint", "checks": [')).toBeNull();
    expect(lintReportOf("exit 0")).toBeNull();
  });

  it("titles a lint_canvas call plainly and ticks or crosses each rule", () => {
    const { ToolCall } = defaultSlots;
    render(
      <ToolCall
        title="mcp__veistra-canvas__lint_canvas"
        toolKind="other"
        status="completed"
        output={JSON.stringify(REPORT)}
        truncated={false}
        paths={[]}
        diffs={[]}
      />,
    );
    expect(screen.getByText("Validating canvas topology")).toBeTruthy();
    expect(screen.getByText("1 check failed")).toBeTruthy();
    expect(screen.getByLabelText("Passed")).toBeTruthy();
    expect(screen.getByLabelText("Failed")).toBeTruthy();
    expect(screen.getByText("a rectangle")).toBeTruthy();
    expect(screen.queryByText("d line")).toBeNull();
    expect(screen.getByText("and 1 more")).toBeTruthy();
  });

  it("shows the card as running before the check answers", () => {
    const { ToolCall } = defaultSlots;
    render(
      <ToolCall
        title="lint_canvas"
        toolKind="other"
        status="inProgress"
        output=""
        truncated={false}
        paths={[]}
        diffs={[]}
      />,
    );
    expect(screen.getByText("Checking frames, groups and labels…")).toBeTruthy();
  });
});

const PASSING = {
  ...REPORT,
  pass: true,
  failedChecks: [],
  checks: REPORT.checks.map((check) => ({ ...check, pass: true, count: 0, issues: [] })),
};

function tool(id: string, title: string, status: ToolStatus, output: string): Item {
  return {
    id,
    turnId: "t1",
    kind: {
      kind: "toolCall",
      title,
      toolKind: "other",
      status,
      output,
      truncated: false,
      paths: [],
      diffs: [],
    },
  };
}

describe("the composer's validation badge", () => {
  const { ValidationBadge } = defaultSlots;
  const badge = (items: Item[]) => render(<ValidationBadge {...latestValidation(items)} />);

  it("takes the newest report, from lint_canvas or add_shapes, and spins while one runs", () => {
    const failing = tool("a", "lint_canvas", "completed", JSON.stringify(REPORT));
    const added = tool("b", "add_shapes", "completed", JSON.stringify({ validation: PASSING }));
    expect(latestValidation([])).toEqual({ running: false, report: null });
    expect(latestValidation([failing, added]).report?.pass).toBe(true);
    expect(latestValidation([added, failing]).report?.pass).toBe(false);
    expect(latestValidation([failing, tool("c", "lint_canvas", "inProgress", "")])).toEqual({
      running: true,
      report: null,
    });
    // A check that ended unreadable leaves the one before it standing.
    expect(latestValidation([failing, tool("d", "lint_canvas", "failed", "boom")]).report).toEqual(
      REPORT,
    );
  });

  it("draws nothing when the session has no report", () => {
    const { container } = badge([tool("x", "ls", "completed", "a.ts")]);
    expect(container.innerHTML).toBe("");
  });

  it("ticks a report that passed", () => {
    badge([tool("a", "lint_canvas", "completed", JSON.stringify(PASSING))]);
    const button = screen.getByRole("button", { name: "Canvas validation passed" });
    expect(button.className).toContain("at-vbadge--pass");
  });

  it("crosses a report that failed, with the count", () => {
    badge([tool("a", "lint_canvas", "completed", JSON.stringify(REPORT))]);
    const button = screen.getByRole("button", { name: "Canvas validation: 1 check failed" });
    expect(button.className).toContain("at-vbadge--fail");
    expect(button.textContent).toBe("1");
  });

  it("spins while a check runs", () => {
    badge([tool("a", "lint_canvas", "pending", "")]);
    const button = screen.getByRole("button", { name: "Canvas validation running" });
    expect(button.querySelector(".at-validation__spin")).toBeTruthy();
  });

  it("lists every rule in a popover, closed by Esc and by a click elsewhere", () => {
    badge([tool("a", "lint_canvas", "completed", JSON.stringify(REPORT))]);
    const button = screen.getByRole("button", { name: /Canvas validation/ });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(button);
    const pop = screen.getByRole("dialog", { name: "Validating canvas topology" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(within(pop).getByText("Every frame has a specific name")).toBeTruthy();
    expect(within(pop).getByText("Every element is inside a frame")).toBeTruthy();
    expect(within(pop).getByLabelText("Passed")).toBeTruthy();
    expect(within(pop).getByLabelText("Failed")).toBeTruthy();
    expect(within(pop).getByText("a rectangle")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
