/**
 * Turns a tool's JSON Schema into the rows an MCP panel draws.
 *
 * Pure and total: any value may be handed in, since a schema comes off the
 * wire, and the worst result is an empty list. Nothing here knows about React.
 * Only the keywords the servers here actually use are read — `type`, `enum`,
 * `const`, `default`, `properties`, `required`, `items`, `anyOf`/`oneOf`,
 * `description` — and anything else is ignored rather than guessed at.
 */

export interface ParamRow {
  name: string;
  /** `string`, `integer[]`, `string | null`, `object`, `enum`, `any`. */
  type: string;
  required: boolean;
  /** `JSON.stringify` of the declared default, when there is one. */
  defaultValue?: string;
  enumValues?: string[];
  description?: string;
  /** Properties of an object, or of an array's object items. */
  children: ParamRow[];
}

type Json = Record<string, unknown>;

/** Past this a schema is almost certainly recursive; stop rather than recurse. */
const MAX_DEPTH = 6;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function variants(schema: Json): Json[] {
  const list = Array.isArray(schema.anyOf) ? schema.anyOf : schema.oneOf;
  return Array.isArray(list) ? list.filter(isObject) : [];
}

/** The type as a reader would say it: `string[]`, `string | null`, `enum`. */
export function typeLabel(schema: unknown): string {
  if (!isObject(schema)) return "any";
  if (Array.isArray(schema.enum) && schema.type === undefined) return "enum";
  if (schema.const !== undefined && schema.type === undefined) return "const";

  const alternatives = variants(schema);
  if (alternatives.length > 0) {
    const labels = alternatives.map(typeLabel);
    return labels.filter((l, i) => labels.indexOf(l) === i).join(" | ");
  }

  const declared = schema.type;
  if (Array.isArray(declared)) {
    return declared.filter((t): t is string => typeof t === "string").join(" | ") || "any";
  }
  if (declared === "array") {
    const inner = typeLabel(schema.items);
    return inner.includes(" ") ? `(${inner})[]` : `${inner}[]`;
  }
  if (typeof declared === "string") return declared;
  if (isObject(schema.properties)) return "object";
  return "any";
}

function enumOf(schema: Json): string[] | undefined {
  const list = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (list === undefined) {
    return schema.const === undefined ? undefined : [JSON.stringify(schema.const)];
  }
  return list.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
}

/** The object schema whose properties should be drawn under this one, if any. */
function nestedObject(schema: Json): Json | undefined {
  if (isObject(schema.properties)) return schema;
  if (schema.type === "array" && isObject(schema.items)) return nestedObject(schema.items);
  for (const variant of variants(schema)) {
    const found = nestedObject(variant);
    if (found !== undefined) return found;
  }
  return undefined;
}

function rowsOf(schema: Json, depth: number): ParamRow[] {
  const properties = schema.properties;
  if (!isObject(properties) || depth > MAX_DEPTH) return [];
  const required = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === "string")
    : [];

  return Object.keys(properties).map((name) => {
    const raw = properties[name];
    const prop = isObject(raw) ? raw : {};
    const nested = nestedObject(prop);
    const alternatives = variants(prop);
    return {
      name,
      type: typeLabel(prop),
      required: required.includes(name),
      defaultValue: prop.default === undefined ? undefined : JSON.stringify(prop.default),
      // The enum of the property itself, or of its only meaningful alternative.
      enumValues: enumOf(prop) ?? alternatives.map(enumOf).find((e) => e !== undefined),
      description:
        text(prop.description) ?? alternatives.map((a) => text(a.description)).find(Boolean),
      children: nested === undefined ? [] : rowsOf(nested, depth + 1),
    };
  });
}

/** The rows for a tool's `inputSchema`. A non-object schema has none. */
export function describeSchema(schema: unknown): ParamRow[] {
  return isObject(schema) ? rowsOf(schema, 0) : [];
}

/**
 * `name(a: string, b?: number)`, the one-line form a client shows beside a tool.
 * Optional parameters carry a `?`; an empty schema gives `name()`.
 */
export function signatureLine(name: string, rows: ParamRow[]): string {
  const params = rows.map((r) => `${r.name}${r.required ? "" : "?"}: ${r.type}`);
  return `${name}(${params.join(", ")})`;
}

/** The first sentence, for the collapsed view. Whole text when there is no full stop. */
export function firstSentence(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const match = /^.*?[.!?](?=\s|$)/.exec(flat);
  return match === null ? flat : match[0];
}
