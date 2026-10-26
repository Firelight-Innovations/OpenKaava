import type { MarkupElement } from "./types";

/** The `customData.veistra` object of an element, or undefined when it has none. */
export function veistraData(el: MarkupElement): Record<string, unknown> | undefined {
  const raw = el.customData?.veistra;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
}

/**
 * A copy of `el` with `patch` applied and the version bumped, which is what
 * Excalidraw compares to decide an element changed. Written by hand because
 * `newElementWith` is not part of the public API of the pinned release.
 */
export function touch<T extends MarkupElement>(el: T, patch: Partial<MarkupElement>): T {
  return {
    ...el,
    ...patch,
    version: (el.version ?? 0) + 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    updated: Date.now(),
  };
}

/** Replaces `customData.veistra` with `veistra` merged over what was there. */
export function withVeistra<T extends MarkupElement>(el: T, veistra: Record<string, unknown>): T {
  return touch(el, {
    customData: { ...el.customData, veistra: { ...veistraData(el), ...veistra } },
  });
}

/** Elements that are still part of the drawing. */
export function live(elements: readonly MarkupElement[]): MarkupElement[] {
  return elements.filter((e) => !e.isDeleted);
}
