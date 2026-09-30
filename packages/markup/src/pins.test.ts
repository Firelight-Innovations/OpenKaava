import { describe, expect, it } from "vitest";
import { el, pin } from "./fixtures";
import {
  PIN_SIZE,
  listPins,
  movePinTo,
  nextPinNumber,
  pinGroupId,
  pinSkeleton,
  setPinNote,
} from "./pins";

const colors = { fill: "#3f76ff", stroke: "#3f76ff", text: "#0f0f10" };

describe("pin numbering", () => {
  it("starts at 1 and counts up", () => {
    expect(nextPinNumber([])).toBe(1);
    expect(nextPinNumber([...pin(1, 0, 0), ...pin(2, 5, 5)])).toBe(3);
  });

  it("never reuses the number of a deleted pin", () => {
    const [marker, label] = pin(3, 0, 0);
    const deleted = [
      { ...marker, isDeleted: true },
      { ...label, isDeleted: true },
    ];
    expect(nextPinNumber([...pin(1, 0, 0), ...deleted])).toBe(4);
  });

  it("honours a high-water mark for callers that dropped deleted elements", () => {
    expect(nextPinNumber(pin(1, 0, 0), 7)).toBe(8);
  });

  it("ignores elements that are not pins", () => {
    expect(
      nextPinNumber([el({ id: "a", type: "arrow", customData: { kaava: { kind: "arrow" } } })]),
    ).toBe(1);
  });
});

describe("pinSkeleton", () => {
  it("is an ellipse centred on the click with the number as its label", () => {
    const s = pinSkeleton({ n: 4, x: 100, y: 50, colors });
    expect(s.type).toBe("ellipse");
    expect(s.x + PIN_SIZE / 2).toBe(100);
    expect(s.y + PIN_SIZE / 2).toBe(50);
    expect(s.label.text).toBe("4");
    expect(s.groupIds).toEqual([pinGroupId(4)]);
    expect(s.label.groupIds).toEqual([pinGroupId(4)]);
  });

  it("records kind, n and an empty note", () => {
    const s = pinSkeleton({ n: 2, x: 0, y: 0, colors });
    expect(s.customData).toEqual({ kaava: { kind: "pin", n: 2, note: "" } });
  });

  it("records nodePath and worldPoint when the host picked something", () => {
    const s = pinSkeleton({
      n: 1,
      x: 0,
      y: 0,
      nodePath: "Root/Door",
      worldPoint: [1, 2, 3],
      note: "too tall",
      colors,
    });
    expect(s.customData.kaava).toEqual({
      kind: "pin",
      n: 1,
      note: "too tall",
      nodePath: "Root/Door",
      worldPoint: [1, 2, 3],
    });
  });

  it("marks the label so a pin is never listed twice", () => {
    const s = pinSkeleton({ n: 5, x: 0, y: 0, colors });
    expect(s.label.customData.kaava).toEqual({ kind: "pin-label", n: 5 });
  });
});

describe("listPins", () => {
  it("returns live pins in number order with their centres", () => {
    const elements = [...pin(2, 40, 40), ...pin(1, 10, 20, [1, 1, 1])];
    const pins = listPins(elements);
    expect(pins.map((p) => p.n)).toEqual([1, 2]);
    expect(pins[0]).toMatchObject({ x: 10, y: 20, nodePath: "Root/Node1", worldPoint: [1, 1, 1] });
  });

  it("skips deleted pins", () => {
    const [m, l] = pin(1, 0, 0);
    expect(listPins([{ ...m, isDeleted: true }, l])).toEqual([]);
  });
});

describe("setPinNote and movePinTo", () => {
  it("sets the note on the marker only, and bumps its version", () => {
    const before = pin(1, 0, 0);
    const after = setPinNote(before, 1, "hello");
    expect(listPins(after)[0].note).toBe("hello");
    expect(after[0].version).toBe(2);
    expect(after[1]).toBe(before[1]);
  });

  it("moves marker and label together", () => {
    const moved = movePinTo(pin(1, 10, 10), 1, 110, 60);
    expect(listPins(moved)[0]).toMatchObject({ x: 110, y: 60 });
    expect(moved[1].x - moved[0].x).toBe(12);
  });

  it("returns the same objects when the pin is already there", () => {
    const before = pin(1, 10, 10);
    const after = movePinTo(before, 1, 10, 10);
    expect(after[0]).toBe(before[0]);
  });
});
