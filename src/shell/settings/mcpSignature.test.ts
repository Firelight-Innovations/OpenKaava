import { describe, expect, it } from "vitest";
import { describeSchema, firstSentence, signatureLine, typeLabel } from "./mcpSignature";

describe("describeSchema", () => {
  it("marks required and optional parameters", () => {
    const rows = describeSchema({
      type: "object",
      properties: { message: { type: "string" }, loud: { type: "boolean" } },
      required: ["message"],
    });
    expect(rows.map((r) => [r.name, r.required])).toEqual([
      ["message", true],
      ["loud", false],
    ]);
  });

  it("carries enum values, defaults and descriptions", () => {
    const [row] = describeSchema({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["a", "b"], default: "a", description: "Which one." },
      },
    });
    expect(row?.enumValues).toEqual(["a", "b"]);
    expect(row?.defaultValue).toBe('"a"');
    expect(row?.description).toBe("Which one.");
  });

  it("leaves description undefined when it is missing or blank", () => {
    const rows = describeSchema({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string", description: "  " } },
    });
    expect(rows.every((r) => r.description === undefined)).toBe(true);
  });

  it("recurses into nested objects", () => {
    const [row] = describeSchema({
      type: "object",
      properties: {
        window: {
          type: "object",
          properties: { id: { type: "string" }, size: { type: "integer" } },
          required: ["id"],
        },
      },
    });
    expect(row?.type).toBe("object");
    expect(row?.children.map((c) => [c.name, c.type, c.required])).toEqual([
      ["id", "string", true],
      ["size", "integer", false],
    ]);
  });

  it("describes arrays by their item type and descends into object items", () => {
    const rows = describeSchema({
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        points: {
          type: "array",
          items: { type: "object", properties: { x: { type: "number" } } },
        },
      },
    });
    expect(rows[0]?.type).toBe("string[]");
    expect(rows[0]?.children).toEqual([]);
    expect(rows[1]?.type).toBe("object[]");
    expect(rows[1]?.children[0]?.name).toBe("x");
  });

  it("reads unions from type arrays and anyOf", () => {
    const rows = describeSchema({
      type: "object",
      properties: {
        a: { type: ["string", "null"] },
        b: { anyOf: [{ type: "string", enum: ["x"] }, { type: "integer" }] },
      },
    });
    expect(rows[0]?.type).toBe("string | null");
    expect(rows[1]?.type).toBe("string | integer");
    expect(rows[1]?.enumValues).toEqual(["x"]);
  });

  it("returns nothing for schemas that are not objects, and survives junk", () => {
    expect(describeSchema(null)).toEqual([]);
    expect(describeSchema([1, 2])).toEqual([]);
    expect(describeSchema({ type: "object", properties: { a: 5 } })[0]?.type).toBe("any");
  });

  it("stops on a self-referencing schema", () => {
    const schema: Record<string, unknown> = { type: "object", properties: {} };
    (schema.properties as Record<string, unknown>).self = schema;
    expect(() => describeSchema(schema)).not.toThrow();
  });
});

describe("typeLabel", () => {
  it("names enums, consts and the unknown", () => {
    expect(typeLabel({ enum: ["a"] })).toBe("enum");
    expect(typeLabel({ const: 1 })).toBe("const");
    expect(typeLabel({})).toBe("any");
    expect(typeLabel(undefined)).toBe("any");
  });
});

describe("signatureLine", () => {
  it("writes optional parameters with a question mark", () => {
    const rows = describeSchema({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    });
    expect(signatureLine("tool", rows)).toBe("tool(a: string, b?: number)");
    expect(signatureLine("ping", [])).toBe("ping()");
  });
});

describe("firstSentence", () => {
  it("cuts at the first full stop followed by a space", () => {
    expect(firstSentence("A PNG of the window. It is app content.")).toBe("A PNG of the window.");
  });
  it("keeps dotted names intact and falls back to the whole text", () => {
    expect(firstSentence("Reaches window.__TAURI__ directly")).toBe(
      "Reaches window.__TAURI__ directly",
    );
    expect(firstSentence("no stop")).toBe("no stop");
  });
});
