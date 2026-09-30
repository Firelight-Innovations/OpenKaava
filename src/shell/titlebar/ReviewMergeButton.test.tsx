// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ReviewMergeButton from "./ReviewMergeButton";

afterEach(cleanup);

describe("ReviewMergeButton", () => {
  it("is a named button that calls its handler", () => {
    const onClick = vi.fn();
    render(<ReviewMergeButton onClick={onClick} />);
    screen.getByRole("button", { name: "Review & merge" }).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
