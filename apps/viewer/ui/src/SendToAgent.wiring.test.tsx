// @vitest-environment jsdom
/** The File Viewer's send buttons, in the shared footer, still reach `context/put`. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@openkaava/bridge", () => ({ invoke: bridge.invoke }));

import SendToAgent from "./SendToAgent";
import { SendFooter } from "../../../shared/SendFooter";

afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

const footer = (props: { dirty?: boolean; onError?: (m: string | null) => void }) =>
  render(
    <SendFooter>
      <SendToAgent
        path="C:/p/a.ts"
        rootPath="C:/p"
        dirty={props.dirty ?? false}
        missing={false}
        onError={props.onError ?? vi.fn()}
      />
    </SendFooter>,
  );

describe("File Viewer send footer", () => {
  it("sends the file and says Sent", async () => {
    bridge.invoke.mockResolvedValue({ key: "k" });
    footer({});
    fireEvent.click(screen.getByRole("button", { name: "Send file" }));
    await screen.findByRole("button", { name: "Sent" });
    expect(bridge.invoke).toHaveBeenCalledWith("context/put", expect.anything());
  });

  it("refuses to send a file with unsaved changes", () => {
    const onError = vi.fn();
    footer({ dirty: true, onError });
    fireEvent.click(screen.getByRole("button", { name: "Send file" }));
    expect(bridge.invoke).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("unsaved changes"));
  });

  it("has no Send selection button without a selection", () => {
    footer({});
    expect(screen.queryByRole("button", { name: "Send selection" })).toBeNull();
  });
});
