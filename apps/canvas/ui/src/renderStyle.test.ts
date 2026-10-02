import { describe, expect, it } from "vitest";
import { DEFAULT_RENDER, currentRender, shape, text, withRender } from "./draw";
import { addShapes, type AddShapesSpec, type LineWidth } from "./layout";

const mono: LineWidth = (line, size) => line.length * size * 0.55;

const spec: AddShapesSpec = {
  frame: { id: "demo", title: "Demo" },
  shapes: [
    { id: "a", type: "rectangle", x: 0, y: 0, label: "Alpha", fill: "blue" },
    { id: "b", type: "rectangle", x: 200, y: 0, label: "Beta", rounded: false },
    { id: "go", type: "arrow", from: "a", to: "b" },
  ],
};

const sketch = {
  roughness: 2,
  fillStyle: "hachure" as const,
  strokeWidth: 1,
  fontFamily: 5,
  fontName: "Excalifont",
  rounded: false,
};

describe("render style", () => {
  it("draws the blueprint when no style is given", () => {
    const out = addShapes([], spec, mono).elements;
    for (const el of out.filter((e) => e.type !== "frame")) {
      expect(el.roughness).toBe(0);
      expect(el.fillStyle).toBe("solid");
    }
    expect(out.find((e) => e.id === "demo:a")?.strokeWidth).toBe(2);
    expect(out.find((e) => e.id === "demo:a")?.roundness).toEqual({ type: 3 });
    expect(out.find((e) => e.type === "text")?.fontFamily).toBe(6);
  });

  it("draws every element in the style it is given", () => {
    const out = withRender(sketch, () => addShapes([], spec, mono).elements);
    const a = out.find((e) => e.id === "demo:a");
    expect(a?.roughness).toBe(2);
    expect(a?.fillStyle).toBe("hachure");
    expect(a?.strokeWidth).toBe(1);
    expect(a?.roundness).toBeNull();
    expect(out.find((e) => e.type === "arrow")?.roughness).toBe(2);
    for (const label of out.filter((e) => e.type === "text")) {
      expect(label.fontFamily).toBe(5);
    }
  });

  it("keeps the frame crisp, since it is the page and not the drawing", () => {
    const out = withRender(sketch, () => addShapes([], spec, mono).elements);
    expect(out.find((e) => e.type === "frame")?.roughness).toBe(0);
  });

  it("lets a shape's own rounded setting beat the style", () => {
    const rounded = withRender({ rounded: false }, () =>
      shape("rectangle", {
        id: "r",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        frameId: null,
        rounded: true,
      }),
    );
    expect(rounded.roundness).toEqual({ type: 3 });
  });

  it("restores the previous style afterwards, even when the layout throws", () => {
    expect(() =>
      withRender(sketch, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(currentRender()).toBe(DEFAULT_RENDER);
    const plain = text({
      id: "t",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      frameId: null,
      text: "x",
      fontSize: 16,
    });
    expect(plain.fontFamily).toBe(6);
  });
});
