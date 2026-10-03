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

const {
  listRecentProjects,
  openProjectInCluster,
  projectIcon,
  chooseProjectIcon,
  onProjectIconChanged,
  iconListeners,
} = vi.hoisted(() => {
  const iconListeners: ((p: { path: string; icon: string | null }) => void)[] = [];
  return {
    listRecentProjects: vi.fn(),
    openProjectInCluster: vi.fn(),
    projectIcon: vi.fn((_path: string) => Promise.resolve(null as string | null)),
    chooseProjectIcon: vi.fn(),
    // Records each subscriber so a test can play the backend's broadcast.
    onProjectIconChanged: vi.fn((cb: (p: { path: string; icon: string | null }) => void) => {
      iconListeners.push(cb);
      return Promise.resolve(() => {});
    }),
    iconListeners,
  };
});

vi.mock("../../bindings", () => ({
  listRecentProjects,
  openProjectInCluster,
  projectIcon,
  chooseProjectIcon,
  onProjectIconChanged,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  iconListeners.length = 0;
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

  it("only says 'Never opened' for a project with no last-opened time", async () => {
    listRecentProjects.mockResolvedValue([
      row({ name: "Seen", initialized: false }),
      row({ name: "Fresh", path: "C:/fresh", initialized: false, lastOpened: null }),
    ]);
    renderDialog();
    await screen.findByText("Seen");
    expect(screen.getAllByText("Never opened in Kaava.")).toHaveLength(1);
    expect(screen.getByText("Not open.")).toBeTruthy();
  });

  it("filters the list by the search field, case-insensitively", async () => {
    listRecentProjects.mockResolvedValue([
      row({ name: "Flashlight" }),
      row({ name: "Torn Apart", path: "C:/torn-apart" }),
    ]);
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

  describe("project icons", () => {
    const DATA = "data:image/png;base64,AAAA";
    const tileOf = (name: RegExp) =>
      screen.getByRole("option", { name }).querySelector(".switch-project__tile");

    it("draws the letter tile for a project with no icon", async () => {
      listRecentProjects.mockResolvedValue([row({ name: "flashlight", path: "C:/flashlight" })]);
      renderDialog();
      await screen.findByText("flashlight");

      await waitFor(() => expect(projectIcon).toHaveBeenCalledWith("C:/flashlight"));
      expect(tileOf(/flashlight/)?.textContent).toBe("F");
      expect(tileOf(/flashlight/)?.querySelector("img")).toBeNull();
    });

    it("draws the project's own icon when it has one", async () => {
      listRecentProjects.mockResolvedValue([row({ name: "Flashlight", path: "C:/flashlight" })]);
      projectIcon.mockResolvedValueOnce(DATA);
      renderDialog();
      await screen.findByText("Flashlight");

      await waitFor(() => expect(tileOf(/Flashlight/)?.querySelector("img")?.src).toBe(DATA));
    });

    it("asks for a new icon for that row's project, and redraws on the broadcast", async () => {
      listRecentProjects.mockResolvedValue([row({ name: "Flashlight", path: "C:/flashlight" })]);
      chooseProjectIcon.mockResolvedValue(DATA);
      renderDialog();
      await screen.findByText("Flashlight");

      fireEvent.click(screen.getByRole("button", { name: "Change icon for Flashlight" }));
      expect(chooseProjectIcon).toHaveBeenCalledWith("C:/flashlight");

      // What `choose_project_icon` emits once the copy is done, in another
      // spelling of the same path, the way Windows hands them out.
      await waitFor(() => expect(iconListeners.length).toBeGreaterThan(0));
      iconListeners.forEach((listener) => listener({ path: "c:\\Flashlight", icon: DATA }));
      await waitFor(() => expect(tileOf(/Flashlight/)?.querySelector("img")?.src).toBe(DATA));
    });

    it("shows why an icon could not be set", async () => {
      listRecentProjects.mockResolvedValue([row({ name: "Flashlight" })]);
      chooseProjectIcon.mockRejectedValue("That image is 900 KiB.");
      renderDialog();
      await screen.findByText("Flashlight");

      fireEvent.click(screen.getByRole("button", { name: "Change icon for Flashlight" }));
      expect(await screen.findByText("That image is 900 KiB.")).toBeTruthy();
    });

    it("offers no icon change for a folder that is gone", async () => {
      listRecentProjects.mockResolvedValue([row({ name: "Gone", exists: false })]);
      renderDialog();
      await screen.findByText("Gone");

      const button = screen.getByRole("button", { name: "Change icon for Gone" });
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });
  });
});

describe("switcher search ring", () => {
  it("overrides the dialog-wide input ring with a more specific selector", async () => {
    const { default: css } = await import("./SwitchProjectDialog.css?raw");
    // dialogs.css rings `.k-dialog :is(..., a[href]):focus-visible` at (0,3,1).
    // Three classes, an element type and the pseudo-class make (0,4,1).
    expect(css).toContain(
      ".k-dialog.switch-project input.switch-project__search-field:focus-visible",
    );
  });
});
