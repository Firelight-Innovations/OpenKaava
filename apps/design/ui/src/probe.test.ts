import { describe, expect, it } from "vitest";
import { CHANNEL, absoluteRect, envelope, readProbeMessage } from "./probe";

/** A payload shaped the way the probe builds one. */
const picked = (overrides: Record<string, unknown> = {}) => ({
  [CHANNEL]: 1,
  kind: "picked",
  element: {
    page: { url: "http://localhost:5173/", title: "Dev", viewportWidth: 1200 },
    target: { tagName: "button", selector: "button.primary", ...overrides },
  },
});

describe("readProbeMessage", () => {
  it("takes a well-formed pick", () => {
    const message = readProbeMessage(picked());
    expect(message?.kind).toBe("picked");
    if (message?.kind !== "picked") throw new Error("unreachable");
    expect(message.element.target.tagName).toBe("button");
    expect(message.element.page.url).toBe("http://localhost:5173/");
  });

  // The channel marker is the only cheap way to tell the probe's traffic from
  // everything else an iframe's window receives, so it is not optional.
  it("ignores anything without the channel marker", () => {
    expect(readProbeMessage({ kind: "picked", element: {} })).toBeNull();
    expect(readProbeMessage({ veistraDesign: 2, kind: "armed" })).toBeNull();
    expect(readProbeMessage("armed")).toBeNull();
    expect(readProbeMessage(null)).toBeNull();
    expect(readProbeMessage(undefined)).toBeNull();
  });

  it("ignores a kind it does not know", () => {
    expect(readProbeMessage({ [CHANNEL]: 1, kind: "somethingElse" })).toBeNull();
  });

  /**
   * The case that matters most. A page can post whatever it likes to its
   * parent, and a half-built pick that got through would render as an element
   * with no tag and no markup — a capture that failed while looking like one
   * that worked.
   */
  it("refuses a pick that is missing either half", () => {
    expect(readProbeMessage({ [CHANNEL]: 1, kind: "picked", element: {} })).toBeNull();
    expect(
      readProbeMessage({ [CHANNEL]: 1, kind: "picked", element: { page: {}, target: {} } }),
    ).toBeNull();
    expect(
      readProbeMessage({
        [CHANNEL]: 1,
        kind: "picked",
        element: { page: {}, target: { tagName: 42 } },
      }),
    ).toBeNull();
  });

  it("drops fields of the wrong type rather than the whole message", () => {
    const message = readProbeMessage(
      picked({
        text: 17,
        html: "<button>Go</button>",
        attributes: { id: "go", onclick: () => {}, count: 3 },
        rect: { x: "10", y: 4, width: 20, height: 8 },
      }),
    );
    if (message?.kind !== "picked") throw new Error("the message should have survived");
    expect(message.element.target.text).toBe("");
    expect(message.element.target.html).toBe("<button>Go</button>");
    expect(message.element.target.attributes).toEqual({ id: "go" });
    expect(message.element.target.rect).toEqual({ x: 0, y: 4, width: 20, height: 8 });
  });

  // A rect carrying NaN reaches Rust, which refuses it — but a refusal is a
  // message the user has to read, and zero is the honest reading of "the page
  // did not say".
  it("treats a non-finite number as absent", () => {
    const message = readProbeMessage(
      picked({ rect: { x: NaN, y: Infinity, width: 5, height: 5 } }),
    );
    if (message?.kind !== "picked") throw new Error("the message should have survived");
    expect(message.element.target.rect.x).toBe(0);
    expect(message.element.target.rect.y).toBe(0);
  });

  it("carries an acknowledgement's id, and refuses one without", () => {
    expect(readProbeMessage({ [CHANNEL]: 1, kind: "veiled", id: "shot-1" })).toEqual({
      kind: "veiled",
      id: "shot-1",
    });
    expect(readProbeMessage({ [CHANNEL]: 1, kind: "veiled" })).toBeNull();
  });

  it("gives a failure something to say when the page said nothing", () => {
    const message = readProbeMessage({ [CHANNEL]: 1, kind: "failed" });
    if (message?.kind !== "failed") throw new Error("expected a failure");
    expect(message.reason.trim()).not.toBe("");
  });
});

describe("envelope", () => {
  it("marks a command so the probe will look at it", () => {
    expect(envelope({ kind: "arm" })).toEqual({ [CHANNEL]: 1, kind: "arm" });
    expect(envelope({ kind: "veil", on: true, id: "a" })).toEqual({
      [CHANNEL]: 1,
      kind: "veil",
      on: true,
      id: "a",
    });
  });
});

describe("absoluteRect", () => {
  it("leaves a top-level element where it is", () => {
    const rect = { x: 10, y: 20, width: 30, height: 40 };
    expect(absoluteRect(rect, [])).toEqual(rect);
  });

  /**
   * The real arrangement: the page sits in an iframe inside the Design Mode
   * app, and the app sits in an iframe inside the shell. Both offsets have to
   * be added or the screenshot is a photograph of the wrong thing — with no
   * error anywhere, which is why this is a test rather than a comment.
   */
  it("adds every frame between the element and the window", () => {
    const element = { x: 12, y: 8, width: 100, height: 24 };
    const pageFrame = { x: 4, y: 96, width: 800, height: 600 };
    const appFrame = { x: 0, y: 70, width: 1200, height: 800 };
    expect(absoluteRect(element, [pageFrame, appFrame])).toEqual({
      x: 16,
      y: 174,
      width: 100,
      height: 24,
    });
  });

  it("keeps the element's own size, whatever the frames are", () => {
    const element = { x: 0, y: 0, width: 7, height: 9 };
    const moved = absoluteRect(element, [{ x: 5, y: 5, width: 999, height: 1 }]);
    expect(moved.width).toBe(7);
    expect(moved.height).toBe(9);
  });
});
