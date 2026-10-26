// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { lintReportOf } from "../validation";
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
