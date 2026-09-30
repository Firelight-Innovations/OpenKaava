import { describe, expect, it } from "vitest";
import { nextAddClusterStep } from "./addClusterFlow";

describe("nextAddClusterStep", () => {
  it("opens the New Cluster dialog when a project is set", () => {
    expect(nextAddClusterStep(true, true)).toBe("new-cluster");
    expect(nextAddClusterStep(true, false)).toBe("new-cluster");
  });

  it("asks for a project first when there is none but a cluster can receive one", () => {
    expect(nextAddClusterStep(false, true)).toBe("pick-project");
  });

  it("only makes a bare cluster when nothing could receive a project", () => {
    expect(nextAddClusterStep(false, false)).toBe("bare");
  });
});
