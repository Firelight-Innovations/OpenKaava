import { describe, expect, it } from "vitest";
import { CLAUDE_SESSION_MARKERS, withoutSessionMarkers } from "./claude-session-env.mjs";

describe("withoutSessionMarkers", () => {
  it("drops every marker and keeps the rest", () => {
    const env = { PATH: "/bin", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDECODE: "1", claude_pid: "9" };
    expect(withoutSessionMarkers(env)).toEqual({ PATH: "/bin" });
  });

  it("keeps user configuration", () => {
    const env = { ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: "/c" };
    expect(withoutSessionMarkers(env)).toEqual(env);
  });

  it("does not mutate its input", () => {
    const env = { CLAUDECODE: "1" };
    withoutSessionMarkers(env);
    expect(env).toEqual({ CLAUDECODE: "1" });
  });

  it("lists upper-case names only", () => {
    for (const name of CLAUDE_SESSION_MARKERS) expect(name).toBe(name.toUpperCase());
  });
});
