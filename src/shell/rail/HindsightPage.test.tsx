// @vitest-environment jsdom
/**
 * Hindsight has no app yet, so the one thing worth pinning is that this
 * placeholder never claims otherwise: no invented bank, no invented event,
 * an honest "not connected" state under both headings.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import HindsightPage from "./HindsightPage";

afterEach(cleanup);

describe("HindsightPage", () => {
  it("lays out the search field, disabled, with no data behind it", () => {
    render(<HindsightPage />);

    const search = screen.getByText("Recall from memory…").closest(".k-hindsight__search");
    expect(search?.getAttribute("aria-disabled")).toBe("true");
  });

  it("says plainly that memory banks and activity are not connected, rather than faking either", () => {
    render(<HindsightPage />);

    expect(screen.getByText("Memory banks")).not.toBeNull();
    expect(screen.getByText("Activity")).not.toBeNull();
    expect(screen.getAllByText("Not connected in this build.")).toHaveLength(2);
  });
});
