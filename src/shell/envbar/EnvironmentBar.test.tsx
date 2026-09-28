// @vitest-environment jsdom
/**
 * The three environment-bar variants, and the honesty rules from this
 * component's own header: no `from base@hash`, no agent-state badge, and a
 * cloud action stays disabled until a real handler exists.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Environment } from "../environment";
import EnvironmentBar from "./EnvironmentBar";

afterEach(cleanup);

describe("EnvironmentBar", () => {
  it("draws a worktree's kind chip, branch, ahead/behind and path", () => {
    const env: Environment = {
      kind: "worktree",
      branch: "wt/flashlight-cone",
      path: "/repo/wt/fl",
    };
    render(<EnvironmentBar environment={env} ahead={3} behind={0} />);

    expect(screen.getByText("Local worktree")).not.toBeNull();
    expect(screen.getByText("wt/flashlight-cone")).not.toBeNull();
    expect(screen.getByText("↑3")).not.toBeNull();
    expect(screen.getByText("↓0")).not.toBeNull();
    expect(screen.getByText("/repo/wt/fl")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Review & merge" })).not.toBeNull();
  });

  it("omits ahead/behind rather than claiming a worktree is caught up", () => {
    const env: Environment = { kind: "worktree", branch: "wt/x", path: "/x" };
    render(<EnvironmentBar environment={env} />);

    expect(screen.queryByText(/↑/)).toBeNull();
    expect(screen.queryByText(/↓/)).toBeNull();
  });

  it("reads main as browse-only, with no branch, path or action", () => {
    const env: Environment = { kind: "main" };
    render(<EnvironmentBar environment={env} />);

    expect(screen.getByText("Main")).not.toBeNull();
    expect(screen.getByText("Browse only · main is read-only")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("draws the cloud variant's two actions disabled while nothing wires them", () => {
    const env: Environment = { kind: "cloud", branch: "agent/anom-142" };
    render(<EnvironmentBar environment={env} />);

    expect(screen.getByText("Cloud session")).not.toBeNull();
    const pull = screen.getByRole("button", { name: "Pull into local worktree" });
    const stop = screen.getByRole("button", { name: "Stop session" });
    expect(pull.hasAttribute("disabled")).toBe(true);
    expect(stop.hasAttribute("disabled")).toBe(true);
    // Cloud draws no ahead/behind or path — those are the worktree variant's.
    expect(screen.queryByText(/↑/)).toBeNull();
  });

  it("enables the cloud actions once real handlers are passed", () => {
    const env: Environment = { kind: "cloud", branch: "agent/anom-142" };
    const onPull = vi.fn();
    const onStop = vi.fn();
    render(<EnvironmentBar environment={env} onPullIntoWorktree={onPull} onStopSession={onStop} />);

    expect(
      screen.getByRole("button", { name: "Pull into local worktree" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.getByRole("button", { name: "Stop session" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("calls onReviewAndMerge when the worktree action is pressed", () => {
    const env: Environment = { kind: "worktree", branch: "wt/x", path: "/x" };
    const onReview = vi.fn();
    render(<EnvironmentBar environment={env} onReviewAndMerge={onReview} />);

    screen.getByRole("button", { name: "Review & merge" }).click();
    expect(onReview).toHaveBeenCalledTimes(1);
  });
});
