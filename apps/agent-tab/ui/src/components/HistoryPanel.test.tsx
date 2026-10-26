// @vitest-environment jsdom
import "../jsdom-shims";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HistoryPanel } from "./HistoryPanel";
import { defaultSlots } from "./registry";

afterEach(cleanup);

it("searches across harnesses, exposes archives, and reopens with a chosen harness", () => {
  const onOpen = vi.fn(),
    onArchive = vi.fn();
  render(
    <HistoryPanel
      sessions={[
        { id: "a", title: "Build the dashboard", updated: 1, harness: "claude", archived: false },
        { id: "b", title: "Fix an old bug", updated: 2, harness: "codex", archived: true },
      ]}
      loading={false}
      error={null}
      onOpen={onOpen}
      onArchive={onArchive}
      onClose={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Search conversations" }), {
    target: { value: "Claude" },
  });
  expect(screen.getByText("Build the dashboard")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Continue with" }), {
    target: { value: "codex" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Build the dashboard/ }));
  expect(onOpen).toHaveBeenCalledWith("a", "codex");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: /Archived/ }));
  expect(screen.getByText("Fix an old bug")).toBeTruthy();
  expect(screen.queryByText("Build the dashboard")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Unarchive conversation" }));
  expect(onArchive).toHaveBeenCalledWith("b", false);
});

it("keeps Claude Ultra out of the Codex effort slider", () => {
  render(
    <defaultSlots.ModelMenu
      label="Agent settings"
      harness="codex"
      sections={[
        {
          label: "Effort",
          value: "high",
          choices: [
            { value: "high", name: "High" },
            { value: "max", name: "Max" },
          ],
          onChange: vi.fn(),
        },
      ]}
      ultracode={{ enabled: false, disabled: false, onChange: vi.fn() }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Agent settings/ }));
  expect(screen.getByRole("slider").getAttribute("max")).toBe("4");
  expect(screen.queryByRole("button", { name: "Ultra effort" })).toBeNull();
});
