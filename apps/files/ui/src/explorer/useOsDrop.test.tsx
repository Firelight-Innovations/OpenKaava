// @vitest-environment jsdom
/**
 * The OS-drop behaviour that matters: which folder a drop lands in, that nothing is called
 * on a read-only checkout, and that a name clash is reported rather than overwritten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { dropFolderAt, importMessage, READ_ONLY_DROP } from "./osDrop";

const handlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
const importFiles = vi.hoisted(() => vi.fn());

vi.mock("@openkaava/bridge", () => ({
  on: (event: string, cb: (payload: unknown) => void) => {
    handlers.set(event, cb);
    return () => handlers.delete(event);
  },
}));
vi.mock("../rpc", () => ({
  describe: (_m: string, e: unknown) => String(e),
  importFiles,
}));

import { useOsDrop } from "./useOsDrop";

function Harness(props: {
  readOnly?: boolean;
  onImported: () => void;
  onProblem: (m: string) => void;
}) {
  const { target } = useOsDrop({
    root: { path: "C:/proj", name: "proj", readOnly: props.readOnly ?? false },
    onImported: props.onImported,
    onProblem: props.onProblem,
  });
  return <div data-testid="target">{target ?? ""}</div>;
}

/** Make `document.elementFromPoint` answer with a row (or nothing, for blank space). */
function pointAt(row: { path: string; kind: "dir" | "file"; parent: string } | null) {
  document.body.innerHTML = "";
  let el: Element | null = null;
  if (row) {
    el = document.createElement("div");
    el.setAttribute("data-path", row.path);
    el.setAttribute("data-kind", row.kind);
    el.setAttribute("data-parent", row.parent);
    document.body.append(el);
  }
  document.elementFromPoint = () => el;
}

const drop = (paths = ["D:/in/a.txt"]) =>
  act(async () => {
    handlers.get("files:os-drag")?.({ phase: "drop", x: 5, y: 5, paths });
  });

beforeEach(() => {
  handlers.clear();
  importFiles.mockReset();
});
afterEach(cleanup);

describe("dropFolderAt", () => {
  it("goes into a folder row, a file row's folder, and the root for blank space", () => {
    pointAt({ path: "C:/proj/src", kind: "dir", parent: "C:/proj" });
    expect(dropFolderAt(document.elementFromPoint(0, 0), "C:/proj")).toBe("C:/proj/src");
    pointAt({ path: "C:/proj/src/a.rs", kind: "file", parent: "C:/proj/src" });
    expect(dropFolderAt(document.elementFromPoint(0, 0), "C:/proj")).toBe("C:/proj/src");
    pointAt(null);
    expect(dropFolderAt(document.elementFromPoint(0, 0), "C:/proj")).toBe("C:/proj");
  });
});

describe("importMessage", () => {
  it("is silent when everything copied", () => {
    expect(
      importMessage("C:/proj", "C:/proj", { copied: ["a"], conflicts: [], failed: [] }),
    ).toBeNull();
  });

  it("names the conflicts and says nothing was overwritten", () => {
    const msg = importMessage("C:/proj/src", "C:/proj", {
      copied: [],
      conflicts: ["a.txt", "b.txt"],
      failed: [],
    });
    expect(msg).toContain('"src"');
    expect(msg).toContain("a.txt, b.txt");
    expect(msg).toContain("Nothing was overwritten");
  });
});

describe("useOsDrop", () => {
  it("copies into the folder row under the cursor, then refreshes", async () => {
    pointAt({ path: "C:/proj/src", kind: "dir", parent: "C:/proj" });
    importFiles.mockResolvedValue({ copied: ["a.txt"], conflicts: [], failed: [] });
    const onImported = vi.fn();
    const onProblem = vi.fn();
    render(<Harness onImported={onImported} onProblem={onProblem} />);

    await drop();

    expect(importFiles).toHaveBeenCalledWith("C:/proj/src", ["D:/in/a.txt"]);
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onProblem).not.toHaveBeenCalled();
  });

  it("copies into the project root when dropped on empty space", async () => {
    pointAt(null);
    importFiles.mockResolvedValue({ copied: ["a.txt"], conflicts: [], failed: [] });
    render(<Harness onImported={vi.fn()} onProblem={vi.fn()} />);
    await drop();
    expect(importFiles).toHaveBeenCalledWith("C:/proj", ["D:/in/a.txt"]);
  });

  it("reports a name clash and does not claim a refresh it did not need", async () => {
    pointAt(null);
    importFiles.mockResolvedValue({ copied: [], conflicts: ["a.txt"], failed: [] });
    const onImported = vi.fn();
    const onProblem = vi.fn();
    render(<Harness onImported={onImported} onProblem={onProblem} />);
    await drop();
    expect(onImported).not.toHaveBeenCalled();
    expect(onProblem.mock.calls[0]?.[0]).toContain("a.txt");
  });

  it("refuses on a read-only checkout without calling the backend", async () => {
    pointAt(null);
    const onProblem = vi.fn();
    render(<Harness readOnly onImported={vi.fn()} onProblem={onProblem} />);
    await drop();
    expect(importFiles).not.toHaveBeenCalled();
    expect(onProblem).toHaveBeenCalledWith(READ_ONLY_DROP);
  });

  it("highlights the folder while a drag is over it, and clears on leave", async () => {
    pointAt({ path: "C:/proj/src", kind: "dir", parent: "C:/proj" });
    const view = render(<Harness onImported={vi.fn()} onProblem={vi.fn()} />);
    await act(async () => {
      handlers.get("files:os-drag")?.({ phase: "over", x: 1, y: 1 });
    });
    expect(view.getByTestId("target").textContent).toBe("C:/proj/src");
    await act(async () => {
      handlers.get("files:os-drag")?.({ phase: "leave" });
    });
    expect(view.getByTestId("target").textContent).toBe("");
  });
});
