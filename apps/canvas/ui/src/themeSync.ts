/** True when Excalidraw is drawing a theme other than the shell's. */
export function themeNeedsPush(drawn: unknown, wanted: "dark" | "light"): boolean {
  return drawn !== undefined && drawn !== wanted;
}
