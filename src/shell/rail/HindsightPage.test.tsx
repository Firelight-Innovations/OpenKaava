// @vitest-environment jsdom
/**
 * The Hindsight page's four states: live, not configured, error, and a check
 * that never answers. The page must never show a bank or an event the service
 * has not reported, and a check that hangs must end in an error, not a spinner.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HindsightStatus } from "../../bindings";
import HindsightPage from "./HindsightPage";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const URL = "https://hindsight.example.run.app";

describe("HindsightPage", () => {
  it("shows the service as connected, with its address and latency, when it answers", async () => {
    const check = vi.fn().mockResolvedValue({ state: "connected", url: URL, latencyMs: 212 });
    render(<HindsightPage check={check} />);

    expect((await screen.findByRole("status")).textContent).toBe("Connected");
    expect(screen.getByText(/hindsight\.example\.run\.app · 212 ms/)).not.toBeNull();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("asks once on open and not again until Check again is pressed", async () => {
    const check = vi.fn().mockResolvedValue({ state: "connected", url: URL, latencyMs: 5 });
    render(<HindsightPage check={check} />);
    await screen.findByText("Connected");

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["gcloudMissing", "The Google Cloud CLI is not installed", "gcloud auth login"],
    ["signedOut", "Signed out of Google Cloud", "gcloud auth login"],
    ["denied", "This Google account may not call Hindsight", "gcloud config set account"],
    ["missing", "Hindsight is not deployed at that address", "KAAVA_HINDSIGHT_URL"],
    ["unreachable", "Hindsight did not answer", ""],
  ])("a %s trouble says what is missing and how to fix it", async (kind, heading, command) => {
    const status: HindsightStatus = { state: "trouble", url: URL, trouble: { kind } };
    render(<HindsightPage check={vi.fn().mockResolvedValue(status)} />);

    expect(await screen.findByText(heading)).not.toBeNull();
    expect((await screen.findByRole("status")).textContent).toBe("Not connected");
    if (command) expect(screen.getByText(command)).not.toBeNull();
  });

  it("reports a rejected call as an error with the reason, not as connected", async () => {
    render(<HindsightPage check={vi.fn().mockRejectedValue(new Error("no backend"))} />);

    expect(await screen.findByText("Could not check Hindsight")).not.toBeNull();
    expect(screen.getByText(/no backend/)).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Not connected");
  });

  it("ends a check that never answers in a timed-out error, with the button live again", async () => {
    vi.useFakeTimers();
    render(<HindsightPage check={() => new Promise(() => {})} timeoutMs={1000} />);
    expect(screen.getByRole("status").textContent).toBe("Checking…");
    expect(
      (screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });

    expect(screen.getByText("Hindsight did not answer in time")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Not connected");
    expect(
      (screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("keeps the recall field disabled and lists no invented banks", async () => {
    render(
      <HindsightPage
        check={vi.fn().mockResolvedValue({ state: "connected", url: URL, latencyMs: 1 })}
      />,
    );
    await screen.findByText("Connected");

    const search = screen.getByText("Recall from memory…").closest(".k-hindsight__search");
    expect(search?.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByText("asset-build")).toBeNull();
    expect(screen.queryByText("godot-build")).toBeNull();
  });
});
