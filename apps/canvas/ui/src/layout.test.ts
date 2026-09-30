import { describe, expect, it } from "vitest";
import type { Element } from "./draw";
import { flapBallSpecs, FLAP_BALL_VALUES } from "./examples/flapBall";
import {
  FRAME_PAD,
  GRID,
  addShapes,
  diagramsIn,
  fillTemplate,
  indexSpec,
  wrap,
  type AddShapesSpec,
  type LineWidth,
} from "./layout";

/** A fixed-pitch stand-in for Nunito: every glyph is 0.55 em wide. */
const mono: LineWidth = (line, size) => line.length * size * 0.55;

const byId = (els: Element[], id: string) => {
  const el = els.find((e) => e.id === id);
  if (!el) throw new Error(`no ${id}`);
  return el;
};

const states: AddShapesSpec = {
  frame: { id: "states", title: "States", summary: "What the game can be doing." },
  shapes: [
    { id: "ready", type: "rectangle", x: 0, y: 0, label: "Ready" },
    { id: "playing", type: "rectangle", x: 300, y: 0, label: "Playing, gravity {{gravity}}" },
    { id: "go", type: "arrow", from: "ready", to: "playing", label: "tap" },
  ],
};

describe("text helpers", () => {
  it("fills known {{names}} and leaves unknown ones as written", () => {
    expect(
      fillTemplate("g = {{gravity}}, v = {{ speed }}, {{nope}}", {
        gravity: { value: 24, unit: "u/s²" },
        speed: 3.5,
      }),
    ).toBe("g = 24, v = 3.5, {{nope}}");
  });

  it("wraps on words and keeps a word longer than the line whole", () => {
    expect(wrap("aa bb cc", 10, 20, mono)).toBe("aa\nbb\ncc");
    expect(wrap("aa bb cc", 10, 30, mono)).toBe("aa bb\ncc");
    expect(wrap("abcdefghij", 10, 20, mono)).toBe("abcdefghij");
  });
});

describe("addShapes", () => {
  const result = addShapes([], states, mono, { gravity: { value: 24 } });

  it("names every element <diagram>:<shape> and returns the ids", () => {
    expect(result.ids).toEqual({
      ready: "states:ready",
      playing: "states:playing",
      go: "states:go",
    });
    expect(result.frame).toMatchObject({ id: "states", elementId: "frame:states", x: 0, y: 0 });
    const frame = result.elements[result.elements.length - 1]!;
    expect(frame.type).toBe("frame");
    expect(frame.customData).toMatchObject({
      kaava: { diagram: { id: "states", title: "States" } },
    });
  });

  it("sizes shapes to their measured labels, on the grid", () => {
    const playing = byId(result.elements, "states:playing");
    const label = byId(result.elements, "states:playing:label");
    expect(label.text).toBe("Playing, gravity 24");
    expect(playing.width as number).toBeGreaterThanOrEqual((label.width as number) + 10);
    expect((playing.width as number) % GRID).toBe(0);
    expect((playing.height as number) % GRID).toBe(0);
    expect(label.customData).toEqual({ kaava: { template: "Playing, gravity {{gravity}}" } });
  });

  it("binds the arrow to both shapes and puts content below the header", () => {
    const go = byId(result.elements, "states:go");
    expect(go.startBinding).toMatchObject({ elementId: "states:ready" });
    expect(go.endBinding).toMatchObject({ elementId: "states:playing" });
    const [, oy] = result.frame.origin;
    const summary = byId(result.elements, "states:_summary");
    expect(oy).toBeGreaterThan((summary.y as number) + (summary.height as number));
  });

  it("sizes the frame to hold everything with padding", () => {
    const { x, y, width, height } = result.frame;
    for (const el of result.elements.slice(0, -1)) {
      expect(el.x as number).toBeGreaterThanOrEqual(x);
      expect((el.x as number) + (el.width as number)).toBeLessThanOrEqual(
        x + width - FRAME_PAD + 1,
      );
      expect((el.y as number) + (el.height as number)).toBeLessThanOrEqual(
        y + height - FRAME_PAD + 1,
      );
    }
  });

  it("moves text off other text and says so", () => {
    const r = addShapes(
      [],
      {
        frame: { id: "clash", title: "Clash" },
        shapes: [
          { id: "one", type: "text", x: 0, y: 0, text: "First note" },
          { id: "two", type: "text", x: 0, y: 0, text: "Second note" },
        ],
      },
      mono,
    );
    expect(r.warnings.some((w) => w.includes("to clear"))).toBe(true);
    const one = byId(r.elements, "clash:one");
    const two = byId(r.elements, "clash:two");
    expect(one.y).not.toBe(two.y);
  });

  it("only reports the overlap when nudge is off", () => {
    const r = addShapes(
      [],
      {
        frame: { id: "clash", title: "Clash" },
        nudge: false,
        shapes: [
          { id: "one", type: "text", x: 0, y: 0, text: "First" },
          { id: "two", type: "text", x: 0, y: 0, text: "Second" },
        ],
      },
      mono,
    );
    expect(r.warnings).toContain("`one` overlaps `two`");
  });

  it("replaces the frame's old contents and keeps its place", () => {
    const moved = addShapes([], { ...states, frame: { ...states.frame, x: 500, y: 80 } }, mono);
    const again = addShapes(moved.elements, { frame: states.frame, shapes: [] }, mono);
    expect(again.frame).toMatchObject({ x: 500, y: 80 });
    expect(again.elements.some((e) => e.id === "states:ready")).toBe(false);
  });

  it("places a new frame to the right of the others", () => {
    const next = addShapes(
      result.elements,
      { frame: { id: "next", title: "Next" }, shapes: [] },
      mono,
    );
    expect(next.frame.x).toBeGreaterThan(result.frame.x + result.frame.width);
  });

  it("rejects bad ids, duplicates and dangling arrows", () => {
    const f = { id: "bad", title: "Bad" };
    expect(() =>
      addShapes([], { frame: { id: "Bad Id", title: "x" }, shapes: [] }, mono),
    ).toThrow();
    expect(() =>
      addShapes(
        [],
        {
          frame: f,
          shapes: [
            { id: "a", type: "text", text: "a" },
            { id: "a", type: "text", text: "b" },
          ],
        },
        mono,
      ),
    ).toThrow(/twice/);
    expect(() =>
      addShapes(
        [],
        { frame: f, shapes: [{ id: "x", type: "arrow", from: "nowhere", to: [0, 0] }] },
        mono,
      ),
    ).toThrow(/not a shape/);
  });
});

describe("the index", () => {
  it("links every named diagram, top level first", () => {
    const a = addShapes(
      [],
      { frame: { id: "detail-one", title: "Detail", level: "detail" }, shapes: [] },
      mono,
    );
    const b = addShapes(
      a.elements,
      { frame: { id: "overview", title: "Overview", level: "overview" }, shapes: [] },
      mono,
    );
    expect(diagramsIn(b.elements).map((d) => d.id)).toEqual(["overview", "detail-one"]);
    const spec = indexSpec(b.elements, mono);
    const links = spec.shapes.filter((s) => s.link).map((s) => s.link);
    expect(links).toEqual(["kaava://diagram/overview", "kaava://diagram/detail-one"]);
  });
});

describe("the Flap Ball example", () => {
  it("builds every frame without overlaps or clipping", () => {
    let scene: Element[] = [];
    const warnings: string[] = [];
    for (const spec of flapBallSpecs()) {
      const r = addShapes(scene, spec, mono, FLAP_BALL_VALUES);
      scene = r.elements;
      warnings.push(...r.warnings.filter((w) => /overlaps|clipped|no free spot/.test(w)));
    }
    expect(warnings).toEqual([]);
    expect(diagramsIn(scene).length).toBeGreaterThanOrEqual(4);
  });
});
