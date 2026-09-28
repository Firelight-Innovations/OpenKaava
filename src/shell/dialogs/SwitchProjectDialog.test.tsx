// @vitest-environment jsdom
/**
 * `SwitchProjectDialog`'s own logic — loading and filtering the recents
 * list, formatting each row's summary and relative time, and what
 * `openProjectInCluster` is called with on a click — rather than `Dialog`'s
 * frame mechanics, which `Dialog.test.tsx` already covers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SwitchProjectDialog from "./SwitchProjectDialog";
import type { RecentProjectRow } from "../../bindings";

const { listRecentProjects, openProjectInCluster } = vi.hoisted(() => ({
  listRecentProjects: vi.fn(),
  openProjectInCluster: vi.fn(),
}));

vi.mock("../../bindings", () => ({
  listRecentProjects,
  openProjectInCluster,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function row(over: Partial<RecentProjectRow> = {}): RecentProjectRow {
  return {
    name: "OpenKaava",
    path: "C:/repo",
    id: "proj-1",
    initialized: true,
    exists: true,
    lastOpened: Date.now() - 5 * 60_000,
    open: false,
    clusterCount: 0,
    environmentCount: 0,
    ...over,
  };
}

function renderDialog(clusterId: string | null = "cluster-1") {
  const onCancel = vi.fn();
  const onOpened = vi.fn();
  const onOpenFolder = vi.fn();
  const onNewProject = vi.fn();
  return {
    onCancel,
    onOpened,
    onOpenFolder,
    onNewProject,
    ...render(
      <SwitchProjectDialog
        clusterId={clusterId}
        onCancel={onCancel}
        onOpened={onOpened}
        onOpenFolder={onOpenFolder}
        onNewProject={onNewProject}
      />,
    ),
  };
}

describe("SwitchProjectDialog", () => {
  it("shows 'No projects opened yet.' when the recent list is empty", async () => {
    listRecentProjects.mockResolvedValue([]);
    renderDialog();
    expect(await screen.findByText("No projects opened yet.")).toBeTruthy();
  });

  it("lists every recent project, with an OPEN badge only on the open one", async () => {
    listRecentProjects.mockResolvedValue([
      row({ name: "Flashlight", open: true, clusterCount: 2, environmentCount: 3 }),
      row({ name: "Torn Apart", path: "C:/torn-apart", open: false }),
    ]);
    renderDialog();

    expect(await screen.findByText("Flashlight")).toBeTruthy();
    expect(screen.getByText("Torn Apart")).toBeTruthy();
    expect(screen.getByText("OPEN")).toBeTruthy();
    expect(screen.getByText("3 environments · 2 clusters")).toBeTruthy();
  });

  it("filters the list by the search field, case-insensitively", async () => {
    listRecentProjects.mockResolvedValue([row({ name: "Flashlight" }), row({ name: "Torn Apart", path: "C:/torn-apart" })]);
    renderDialog();
    await screen.findByText("Flashlight");

    fireEvent.change(screen.getByPlaceholderText("Switch project…"), { target: { value: "torn" } });
    expect(screen.queryByText("Flashlight")).toBeNull();
    expect(screen.getByText("Torn Apart")).toBeTruthy();
  });

  it("shows 'No project matches.' when a filter matches nothing", async () => {
    listRecentProjects.mockResolvedValue([row({ name: "Flashlight" })]);
    renderDialog();
    await screen.findByText("Flashlight");

    fireEvent.change(screen.getByPlaceholderText("Switch project…"), { target: { value: "zzz" } });
    expect(await screen.findByText("No project matches.")).toBeTruthy();
  });

  it("marks a missing folder instead of a summary, and refuses to open it", async () => {
    listRecentProjects.mockResolvedValue([row({ name: "Gone", exists: false, open: true })]);
    renderDialog();

    expect(await screen.findByText("Folder not found.")).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /Gone/ }));
    expect(openProjectInCluster).not.toHaveBeenCalled();
  });

  it("opens the chosen project into the given cluster and reports success", async () => {
    listRecentProjects.mockResolvedValue([row({ name: "Flashlight", path: "C:/flashlight" })]);
    openProjectInCluster.mockResolvedValue({ open: null, recents: [] });
    const { onOpened } = renderDialog("cluster-7");

    fireEvent.click(await screen.findByRole("option", { name: /Flashlight/ }));
    await waitFor(() => expect(onOpened).toHaveBeenCalled());
    expect(openProjectInCluster).toHaveBeenCalledWith("cluster-7", "C:/flashlight");
  });

  it("does nothing on click when there is no cluster to open into", async () => {
    listRecentProjects.mockResolvedValue([row({ name: "Flashlight" })]);
    renderDialog(null);

    fireEvent.click(await screen.findByRole("option", { name: /Flashlight/ }));
    expect(openProjectInCluster).not.toHaveBeenCalled();
  });

  it("shows the rejection message on failure, without closing", async () => {
    listRecentProjects.mockResolvedValue([row({ name: "Flashlight", path: "C:/flashlight" })]);
    openProjectInCluster.mockRejectedValue("that folder is not a git repository");
    const { onOpened } = renderDialog();

    fireEvent.click(await screen.findByRole("option", { name: /Flashlight/ }));
    expect(await screen.findByText("that folder is not a git repository")).toBeTruthy();
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("wires the footer buttons straight through", async () => {
    listRecentProjects.mockResolvedValue([]);
    const { onOpenFolder, onNewProject } = renderDialog();
    await screen.findByText("No projects opened yet.");

    fireEvent.click(screen.getByRole("button", { name: "Open folder…" }));
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(onOpenFolder).toHaveBeenCalledTimes(1);
    expect(onNewProject).toHaveBeenCalledTimes(1);
  });
});
