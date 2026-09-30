import { describe, expect, it } from "vitest";
import type { SceneElement } from "./scene";
import {
  EMPTY_DRAFT,
  cardToDraft,
  draftToCard,
  exportDraft,
  exportJson,
  filterRows,
  selectedElement,
  specOf,
  summarise,
  validateDraft,
  withSpec,
  type AssetRow,
  type SpecDraft,
} from "./spec";

const valid: SpecDraft = {
  name: "Anomaly chair",
  reference_images: "refs/chair-front.png\n\n  https://example.test/chair.jpg  ",
  size_m: "1.2",
  triangle_budget: "5000",
  style_notes: "Worn leather, brass studs.",
  status: "draft",
};

describe("validateDraft", () => {
  it("accepts a complete card", () => {
    expect(validateDraft(valid)).toEqual({});
  });

  it("names every missing or bad field", () => {
    const issues = validateDraft(EMPTY_DRAFT);
    expect(Object.keys(issues).sort()).toEqual(["name", "size_m", "triangle_budget"]);
  });

  it.each([
    ["size_m", "0"],
    ["size_m", "-2"],
    ["size_m", "abc"],
    ["triangle_budget", "12.5"],
    ["triangle_budget", "0"],
    ["triangle_budget", "1e400"],
  ] as const)("rejects %s = %s", (field, value) => {
    expect(validateDraft({ ...valid, [field]: value })[field]).toBeTruthy();
  });

  it("does not need reference images or style notes", () => {
    expect(validateDraft({ ...valid, reference_images: "", style_notes: "" })).toEqual({});
  });
});

describe("exportDraft", () => {
  it("exports valid JSON with exactly the five documented fields", () => {
    const out = exportDraft(valid);
    if (!out.ok) throw new Error("expected a valid export");
    const parsed = JSON.parse(out.json);
    expect(Object.keys(parsed)).toEqual([
      "name",
      "reference_images",
      "size_m",
      "triangle_budget",
      "style_notes",
    ]);
    expect(parsed).toEqual({
      name: "Anomaly chair",
      reference_images: ["refs/chair-front.png", "https://example.test/chair.jpg"],
      size_m: 1.2,
      triangle_budget: 5000,
      style_notes: "Worn leather, brass studs.",
    });
  });

  it("leaves the review state out, since the artifact carries that", () => {
    const out = exportDraft({ ...valid, status: "accepted" });
    if (!out.ok) throw new Error("expected a valid export");
    expect(JSON.parse(out.json)).not.toHaveProperty("status");
  });

  it("refuses a card that is not valid, with the reasons", () => {
    const out = exportDraft({ ...valid, name: " " });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issues.name).toBeTruthy();
  });

  it("round-trips through the stored form", () => {
    const card = draftToCard(valid)!;
    expect(draftToCard(cardToDraft(card))).toEqual(card);
    expect(JSON.parse(exportJson(card)).name).toBe("Anomaly chair");
  });
});

describe("withSpec and specOf", () => {
  const el: SceneElement = {
    id: "a",
    type: "frame",
    version: 3,
    customData: { kaava: { child: "world/ward-b" }, other: 1 },
  };

  it("adds a card without disturbing the frame link, and raises the version", () => {
    const card = draftToCard(valid)!;
    const next = withSpec(el, card);
    expect(next.version).toBe(4);
    expect(next.versionNonce).not.toBe(el.versionNonce);
    expect(next.customData).toEqual({
      kaava: { child: "world/ward-b", spec: card },
      other: 1,
    });
    expect(specOf(next)).toEqual(card);
    expect(el.customData).toEqual({ kaava: { child: "world/ward-b" }, other: 1 });
  });

  it("removes the card and tidies empty containers", () => {
    const bare: SceneElement = { id: "b", type: "rectangle" };
    const withCard = withSpec(bare, draftToCard(valid)!);
    const gone = withSpec(withCard, null);
    expect(gone.customData).toBeUndefined();
    expect(specOf(gone)).toBeNull();
  });

  it("ignores deleted elements and non-object specs", () => {
    const card = draftToCard(valid)!;
    expect(specOf({ ...withSpec(el, card), isDeleted: true })).toBeNull();
    expect(specOf({ id: "x", type: "rectangle", customData: { kaava: { spec: [1] } } })).toBeNull();
    expect(specOf({ id: "x", type: "rectangle" })).toBeNull();
  });
});

describe("selectedElement", () => {
  const els: SceneElement[] = [
    { id: "a", type: "rectangle" },
    { id: "b", type: "ellipse", isDeleted: true },
  ];
  it("needs exactly one live selected element", () => {
    expect(selectedElement(els, { a: true })?.id).toBe("a");
    expect(selectedElement(els, { a: true, b: true })).toBeNull();
    expect(selectedElement(els, { b: true })).toBeNull();
    expect(selectedElement(els, { a: false })).toBeNull();
    expect(selectedElement(els, undefined)).toBeNull();
  });
});

describe("asset list aggregation", () => {
  const row = (
    canvas: string,
    elementId: string,
    spec: Record<string, unknown>,
    status = "draft",
  ): AssetRow => ({ canvas, canvasTitle: canvas, elementId, spec, status });

  const full = { name: "Zed", size_m: 1, triangle_budget: 100 };
  const rows = [
    row("world/ward-b", "1", { ...full, name: "Gurney" }, "review"),
    row("world", "2", { ...full, name: "Chair" }, "accepted"),
    row("world", "3", { name: "Half done" }),
    row("world/ward-a", "4", { ...full, name: "Chair" }, "review"),
    row("world", "5", { ...full, name: "Odd" }, "banana"),
  ];

  it("counts every state, treating an unknown one as draft", () => {
    expect(summarise(rows)).toEqual({
      total: 5,
      byStatus: { draft: 2, review: 2, accepted: 1, rejected: 0 },
      incomplete: 1,
    });
  });

  it("counts nothing for an empty list, every state present", () => {
    expect(summarise([])).toEqual({
      total: 0,
      byStatus: { draft: 0, review: 0, accepted: 0, rejected: 0 },
      incomplete: 0,
    });
  });

  it("filters by state and sorts by name, then canvas", () => {
    expect(filterRows(rows, "review").map((r) => `${r.spec.name}@${r.canvas}`)).toEqual([
      "Chair@world/ward-a",
      "Gurney@world/ward-b",
    ]);
    expect(filterRows(rows, null).map((r) => r.elementId)).toEqual(["2", "4", "1", "3", "5"]);
    expect(filterRows(rows, "rejected")).toEqual([]);
  });
});
