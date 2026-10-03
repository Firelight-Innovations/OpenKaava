import { describe, expect, it } from "vitest";
import {
  changeType,
  convertLegacy,
  objectOf,
  parseInput,
  setProp,
  targetOf,
  withObject,
  wrapSelection,
  type FieldDef,
  type TypeDef,
} from "./objects";
import type { SceneElement } from "./scene";

const el = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    version: 1,
    versionNonce: 1,
    ...extra,
  }) as SceneElement;
const frame = (id: string, extra: Record<string, unknown> = {}) =>
  el(id, { type: "frame", ...extra });

const def = (id: string, fields: FieldDef[]): TypeDef => ({
  id,
  name: id,
  color: "#000",
  icon: "shapes",
  fields,
  builtin: false,
});

describe("a frame that is both a named diagram and a typed object", () => {
  const diagram = { id: "hub", title: "Hub", level: "overview" };
  const both = () =>
    frame("f", { customData: { kaava: { diagram, child: "kid" }, other: { keep: 1 } } });

  it("withObject adds the object and keeps the diagram, child and foreign data", () => {
    const out = withObject(both(), { type: "feature", props: { a: 1 } });
    expect(out.customData).toEqual({
      kaava: { diagram, child: "kid", object: { type: "feature", props: { a: 1 } } },
      other: { keep: 1 },
    });
    expect(objectOf(out)?.type).toBe("feature");
  });

  it("removing the object leaves the diagram, and removing the last key drops customData", () => {
    const typed = withObject(both(), { type: "feature", props: {} });
    expect(withObject(typed, null).customData).toEqual({
      kaava: { diagram, child: "kid" },
      other: { keep: 1 },
    });
    const only = withObject(frame("g"), { type: "feature", props: {} });
    expect(withObject(only, null).customData).toBeUndefined();
  });

  it("changing the type, setting a prop and renaming keep the diagram", () => {
    const typed = withObject(both(), { type: "feature", props: { a: 1 } });
    const next = withObject(typed, setProp(changeType(objectOf(typed), def("system", [])), "b", 2));
    expect((next.customData as { kaava: { diagram: unknown } }).kaava.diagram).toEqual(diagram);
    expect(objectOf(next)).toEqual({ type: "system", props: { a: 1, b: 2 } });
  });

  it("targetOf reports the type and the child of the same frame", () => {
    const typed = withObject(both(), { type: "feature", props: {} });
    expect(targetOf([typed], { f: true })).toMatchObject({
      kind: "frame",
      object: { type: "feature" },
      child: "kid",
    });
  });
});

describe("parseInput", () => {
  const f = (kind: FieldDef["kind"], extra: Partial<FieldDef> = {}): FieldDef => ({
    key: "k",
    label: "K",
    kind,
    ...extra,
  });
  it("reads numbers, and treats empty as unset", () => {
    expect(parseInput(f("number"), "2.5")).toEqual({ ok: true, value: 2.5 });
    expect(parseInput(f("number"), " ")).toEqual({ ok: true, value: null });
    expect(parseInput(f("number"), "lots").ok).toBe(false);
  });
  it("splits a path list into trimmed lines", () => {
    expect(parseInput(f("path-list"), "a.png\n\n  b.png ")).toEqual({
      ok: true,
      value: ["a.png", "b.png"],
    });
  });
  it("accepts only listed enum options", () => {
    const e = f("enum", { options: ["draft", "review"] });
    expect(parseInput(e, "review").ok).toBe(true);
    expect(parseInput(e, "done").ok).toBe(false);
  });
});

describe("changeType", () => {
  it("keeps values for fields that still exist, and those that do not", () => {
    const a = def("a", [{ key: "size", label: "Size", kind: "number" }]);
    const b = def("b", [
      { key: "size", label: "Size", kind: "number" },
      { key: "mood", label: "Mood", kind: "text", default: "calm" },
    ]);
    const first = changeType(null, a);
    const filled = setProp(first, "size", 4);
    const second = changeType(filled, b);
    expect(second).toEqual({ type: "b", props: { size: 4, mood: "calm" } });
    expect(changeType(second, a).props.mood).toBe("calm");
  });
});

describe("wrapSelection", () => {
  it("puts the selected shapes in one new frame, listed after them", () => {
    const got = wrapSelection([el("a"), el("b", { x: 100 }), el("c")], { a: true, b: true });
    if (!got.ok) throw new Error(got.error);
    const made = got.elements.slice(-1)[0]!;
    expect(made.type).toBe("frame");
    expect(made.id).toBe(got.frameId);
    expect(made.width).toBeGreaterThan(110);
    const framed = got.elements.filter((e) => e.frameId === got.frameId).map((e) => e.id);
    expect(framed).toEqual(["a", "b"]);
  });
  it("refuses an empty selection and one that holds a frame", () => {
    expect(wrapSelection([el("a")], {}).ok).toBe(false);
    expect(wrapSelection([el("a"), frame("f")], { a: true, f: true }).ok).toBe(false);
  });
});

describe("convertLegacy", () => {
  it("moves a shape's spec card onto a model frame around it", () => {
    const card = { name: "Gurney", size_m: 2, triangle_budget: 8000, status: "review" };
    const shape = el("a", { customData: { kaava: { spec: card } } });
    const got = convertLegacy([shape], "a");
    if (!got.ok) throw new Error(got.error);
    const made = got.elements.find((e) => e.id === got.frameId)!;
    expect(made.name).toBe("Gurney");
    expect(objectOf(made)).toEqual({
      type: "model",
      props: { size_m: 2, triangle_budget: 8000, review_state: "review" },
    });
    expect(got.elements.find((e) => e.id === "a")!.customData).toBeUndefined();
  });
});

describe("targetOf", () => {
  const typed = withObject(frame("f", { name: "Ward" }), { type: "feature", props: {} });
  it("tells a frame, a framed shape, a loose shape and a crowd apart", () => {
    const els = [typed, el("in", { frameId: "f" }), el("loose")];
    expect(targetOf(els, { f: true })).toMatchObject({ kind: "frame", name: "Ward" });
    expect(targetOf(els, { in: true })).toMatchObject({ kind: "shape", frame: { id: "f" } });
    expect(targetOf(els, { loose: true })).toMatchObject({ kind: "shape", frame: null });
    expect(targetOf(els, { in: true, loose: true })).toMatchObject({
      kind: "many",
      wrappable: true,
    });
    expect(targetOf(els, {})).toEqual({ kind: "none" });
  });
});
