/**
 * Asset spec cards (P7-4) and the asset list built from them (P7-5).
 *
 * `docs/cloud-services.md` §4 fixes the card: an element carrying
 * `customData.kaava.spec = { name, reference_images, size_m, triangle_budget,
 * style_notes }`. `status` is added here as the card's own review state; the
 * document joins the cloud artifact's status instead, which needs the cloud
 * store and is not available in a local checkout. `status` is therefore never
 * part of the exported JSON, which is exactly the five documented fields.
 *
 * Everything is pure, so validation, export and the list are tested without
 * Excalidraw.
 */
import type { SceneElement } from "./scene";

export const STATUSES = ["draft", "review", "accepted", "rejected"] as const;
export type SpecStatus = (typeof STATUSES)[number];

export interface SpecCard {
  name: string;
  reference_images: string[];
  /** Largest dimension in metres. */
  size_m: number;
  triangle_budget: number;
  style_notes: string;
  status?: SpecStatus;
}

/** What the form edits: numbers stay strings until they are checked. */
export interface SpecDraft {
  name: string;
  reference_images: string;
  size_m: string;
  triangle_budget: string;
  style_notes: string;
  status: SpecStatus;
}

export const EMPTY_DRAFT: SpecDraft = {
  name: "",
  reference_images: "",
  size_m: "",
  triangle_budget: "",
  style_notes: "",
  status: "draft",
};

export type SpecField = "name" | "size_m" | "triangle_budget";

/** The fields wrong with a draft, by field name; empty when it is valid. */
export type SpecIssues = Partial<Record<SpecField, string>>;

const isStatus = (v: unknown): v is SpecStatus =>
  typeof v === "string" && (STATUSES as readonly string[]).includes(v);

export function statusOf(spec: { status?: unknown } | null | undefined): SpecStatus {
  const status = spec?.status;
  return isStatus(status) ? status : "draft";
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

export function validateDraft(draft: SpecDraft): SpecIssues {
  const issues: SpecIssues = {};
  if (draft.name.trim() === "") issues.name = "A name is required.";
  const size = draft.size_m.trim() === "" ? NaN : Number(draft.size_m);
  if (!Number.isFinite(size) || size <= 0) issues.size_m = "Enter a size in metres above 0.";
  const tris = draft.triangle_budget.trim() === "" ? NaN : Number(draft.triangle_budget);
  if (!Number.isInteger(tris) || tris <= 0) {
    issues.triangle_budget = "Enter a whole number of triangles above 0.";
  }
  return issues;
}

/** The card a valid draft describes, or `null` when it has issues. */
export function draftToCard(draft: SpecDraft): SpecCard | null {
  if (Object.keys(validateDraft(draft)).length > 0) return null;
  return {
    name: draft.name.trim(),
    reference_images: splitLines(draft.reference_images),
    size_m: Number(draft.size_m),
    triangle_budget: Number(draft.triangle_budget),
    style_notes: draft.style_notes.trim(),
    status: draft.status,
  };
}

/** Whatever is stored, as form text. Unknown or missing fields become empty. */
export function cardToDraft(raw: unknown): SpecDraft {
  const r = (raw ?? {}) as Record<string, unknown>;
  const refs = Array.isArray(r.reference_images)
    ? r.reference_images.filter((x): x is string => typeof x === "string")
    : [];
  return {
    name: typeof r.name === "string" ? r.name : "",
    reference_images: refs.join("\n"),
    size_m: typeof r.size_m === "number" ? String(r.size_m) : "",
    triangle_budget: typeof r.triangle_budget === "number" ? String(r.triangle_budget) : "",
    style_notes: typeof r.style_notes === "string" ? r.style_notes : "",
    status: statusOf(r as { status?: unknown }),
  };
}

/** The issues a stored card has, for the list. */
export function issuesOfStored(raw: unknown): SpecIssues {
  return validateDraft(cardToDraft(raw));
}

/**
 * The card as the JSON the Go step consumes: exactly the five documented
 * fields, in a fixed order, two-space indented.
 */
export function exportJson(card: SpecCard): string {
  const { name, reference_images, size_m, triangle_budget, style_notes } = card;
  return JSON.stringify({ name, reference_images, size_m, triangle_budget, style_notes }, null, 2);
}

/**
 * The export for a draft: its JSON, or the issues that prevent it. A half-filled
 * card is refused here rather than failing later and further away.
 */
export function exportDraft(
  draft: SpecDraft,
): { ok: true; json: string } | { ok: false; issues: SpecIssues } {
  const card = draftToCard(draft);
  if (!card) return { ok: false, issues: validateDraft(draft) };
  return { ok: true, json: exportJson(card) };
}

/** The element's spec card as stored, or `null` when it is not a card. */
export function specOf(el: SceneElement): Record<string, unknown> | null {
  if (el.isDeleted) return null;
  const custom = el.customData as { kaava?: { spec?: unknown } } | undefined;
  const spec = custom?.kaava?.spec;
  return spec && typeof spec === "object" && !Array.isArray(spec)
    ? (spec as Record<string, unknown>)
    : null;
}

/**
 * `el` with its spec card set (or removed, with `null`), keeping the rest of
 * `customData` such as a frame's child link. Raises `version` for the same
 * reason `withChild` does.
 */
export function withSpec(el: SceneElement, card: SpecCard | null): SceneElement {
  const custom = { ...((el.customData as Record<string, unknown> | undefined) ?? {}) };
  const kaava = { ...((custom.kaava as Record<string, unknown> | undefined) ?? {}) };
  if (card === null) delete kaava.spec;
  else kaava.spec = card;
  if (Object.keys(kaava).length > 0) custom.kaava = kaava;
  else delete custom.kaava;
  return {
    ...el,
    customData: Object.keys(custom).length > 0 ? custom : undefined,
    version: (el.version ?? 0) + 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    updated: Date.now(),
  };
}

/** The one selected live element, or `null` for none or several. */
export function selectedElement(
  elements: readonly SceneElement[],
  selectedIds: Record<string, unknown> | undefined,
): SceneElement | null {
  const ids = Object.keys(selectedIds ?? {}).filter((id) => selectedIds?.[id]);
  if (ids.length !== 1) return null;
  const el = elements.find((e) => e.id === ids[0]);
  return el && !el.isDeleted ? el : null;
}

// --- the asset list ---------------------------------------------------------

/** One row of `canvas/assets`. */
export interface AssetRow {
  canvas: string;
  canvasTitle: string;
  elementId: string;
  spec: Record<string, unknown>;
  status: string;
}

export interface AssetsResult {
  cards: AssetRow[];
  canvases: number;
  unreadable: string[];
}

export interface ListSummary {
  total: number;
  /** Count per review state, every state present even at 0. */
  byStatus: Record<SpecStatus, number>;
  /** Cards whose data is incomplete, so a bad card is visible in the list. */
  incomplete: number;
}

export function summarise(rows: readonly AssetRow[]): ListSummary {
  const byStatus: Record<SpecStatus, number> = { draft: 0, review: 0, accepted: 0, rejected: 0 };
  let incomplete = 0;
  for (const row of rows) {
    byStatus[statusOf(row)] += 1;
    if (Object.keys(issuesOfStored(row.spec)).length > 0) incomplete += 1;
  }
  return { total: rows.length, byStatus, incomplete };
}

/** Rows with the given review state (`null` for all), then by name, canvas, element. */
export function filterRows(rows: readonly AssetRow[], status: SpecStatus | null): AssetRow[] {
  const nameOf = (r: AssetRow) => (typeof r.spec.name === "string" ? r.spec.name : "");
  return rows
    .filter((r) => status === null || statusOf(r) === status)
    .slice()
    .sort(
      (a, b) =>
        nameOf(a).localeCompare(nameOf(b)) ||
        a.canvas.localeCompare(b.canvas) ||
        a.elementId.localeCompare(b.elementId),
    );
}
