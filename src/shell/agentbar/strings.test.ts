import { describe, expect, it } from "vitest";
import { strings } from "./strings";

/**
 * Every hint the bar words is one the host sends. The host's `Hint` union is
 * generated into the agent tab's `protocol.generated.ts`, which the shell may
 * not import, so this reads it as text. `tsc` holds the bar's table to
 * `BarHint`; this holds `BarHint` to the host.
 */
const generated = import.meta.glob("../../../apps/agent-tab/ui/src/protocol.generated.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function hostHints(): string[] {
  const source = Object.values(generated)[0] ?? "";
  const union = /export type Hint = ([^;]+);/.exec(source)?.[1] ?? "";
  return [...union.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();
}

describe("the agent bar's hints", () => {
  it("are the host's, and the two it reports before a session starts", () => {
    const hints = hostHints();
    expect(hints).toContain("signedOut");
    expect(Object.keys(strings.hint).sort()).toEqual(["adapterMissing", "harnessMissing"]);
    for (const hint of Object.keys(strings.hint)) expect(hints).toContain(hint);
  });
});
