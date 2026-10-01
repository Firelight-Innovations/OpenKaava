// @vitest-environment jsdom
/** A terminal hosted in a pane gets the same Context strip the band's sessions do. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("./XTermView", () => ({
  default: ({ id }: { id: string }) => <div data-testid={`xterm-${id}`} />,
}));
vi.mock("./ContextStrip", () => ({
  default: ({ sessionId }: { sessionId: string }) => <div data-testid={`strip-${sessionId}`} />,
  ContextNotice: ({ sessionId }: { sessionId: string }) => (
    <div data-testid={`notice-${sessionId}`} />
  ),
}));

import PaneTerminal from "./PaneTerminal";
import type { TerminalTransport } from "../contract";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});

afterEach(cleanup);

describe("PaneTerminal", () => {
  it("renders the emulator with its Context strip and notice", () => {
    render(
      <PaneTerminal
        id="pane-term-1"
        transport={{} as TerminalTransport}
        onTitle={() => {}}
        fileDropActive={false}
      />,
    );
    expect(screen.getByTestId("xterm-pane-term-1")).toBeTruthy();
    expect(screen.getByTestId("strip-pane-term-1")).toBeTruthy();
    expect(screen.getByTestId("notice-pane-term-1")).toBeTruthy();
  });
});
