/** Model ordering and effort presentation, independent of harness version names. */
import type { PickerChoice } from "./components/types";

/** Newest versions first; equal versions keep the adapter's recommendation order. */
export function newestModels(models: readonly PickerChoice[]): PickerChoice[] {
  const version = (m: PickerChoice) =>
    (m.name.match(/\d+(?:\.\d+)+|\d+/)?.[0] ?? "0").split(".").map(Number);
  return [...models].sort((a, b) => {
    const av = version(a),
      bv = version(b);
    for (let i = 0; i < Math.max(av.length, bv.length); i++) {
      const diff = (bv[i] ?? 0) - (av[i] ?? 0);
      if (diff) return diff;
    }
    return 0;
  });
}

/** One latest model per named family; older versions and aliases live under More. */
export function featuredModels(
  models: readonly PickerChoice[],
  selected: string | null,
): PickerChoice[] {
  const families = new Set<string>();
  const featured = newestModels(models)
    .filter((model) => {
      if (model.value === "default") return false;
      const family = model.name
        .toLowerCase()
        .replace(/\d+(?:\.\d+)*/g, "")
        .replace(/\([^)]*\)|\[[^\]]*\]/g, "")
        .trim();
      if (families.has(family)) return false;
      families.add(family);
      return true;
    })
    .slice(0, 4);
  const picked = models.find((m) => m.value === selected);
  if (picked && !featured.some((m) => m.value === selected)) featured.push(picked);
  return featured.length ? featured : models.slice(0, 4);
}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Ultra and Max use the fifth animation; names on the wire are preserved. */
export function effortIndex(value: string): number {
  return value === "ultra" ? 4 : EFFORT_LEVELS.indexOf(value as (typeof EFFORT_LEVELS)[number]);
}
