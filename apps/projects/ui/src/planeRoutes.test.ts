import { describe, expect, it } from "vitest";
import {
  PLANE_ORIGIN,
  WORKSPACE,
  isPlaneOrigin,
  issueUrl,
  projectUrl,
  workspaceUrl,
} from "./planeRoutes";

describe("planeRoutes", () => {
  it("builds the workspace URL under the pinned origin and workspace", () => {
    expect(workspaceUrl()).toBe(`${PLANE_ORIGIN}/${WORKSPACE}/`);
  });

  it("builds a project's issue board from its Plane project id", () => {
    expect(projectUrl("abc-123")).toBe(`${PLANE_ORIGIN}/${WORKSPACE}/projects/abc-123/issues/`);
  });

  it("builds one issue's own URL under its project", () => {
    expect(issueUrl("abc-123", "issue-9")).toBe(
      `${PLANE_ORIGIN}/${WORKSPACE}/projects/abc-123/issues/issue-9/`,
    );
  });

  it("accepts only the pinned Plane origin", () => {
    expect(isPlaneOrigin(projectUrl("abc-123"))).toBe(true);
    expect(isPlaneOrigin("http://localhost:8765/veistra/")).toBe(false);
    expect(isPlaneOrigin("not a url")).toBe(false);
  });
});
