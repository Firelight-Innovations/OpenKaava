import { describe, expect, it } from "vitest";
import { harnessChoices } from "./harnesses";
import type { HarnessInfo } from "./protocol.generated";

const CLAUDE: HarnessInfo = {
  harness: "claude",
  name: "Claude",
  hint: null,
  setup: { cli: "claude", signIn: "claude", adapterInstall: "", adapterVersion: "0.90.0" },
  capabilities: { steer: false, fork: false, modes: true },
};
const OPUS = { value: "opus", name: "Opus 5.5" };
const SONNET = { value: "sonnet", name: "Sonnet 5.5" };

describe("harnessChoices", () => {
  it("lists Claude, Codex and Kaava, and the ones the host does not run are coming soon", () => {
    const listed = harnessChoices([CLAUDE], "claude", null);
    expect(listed.map((h) => [h.name, h.unavailable])).toEqual([
      ["Claude", null],
      ["Codex", "Coming soon"],
      ["Kaava", "Coming soon"],
    ]);
  });

  it("takes the models the host scanned", () => {
    const scanned = { ...CLAUDE, models: [OPUS, SONNET], model: "opus" };
    expect(harnessChoices([scanned], null, null)[0]).toMatchObject({
      models: [OPUS, SONNET],
      model: "opus",
    });
  });

  it("takes the running session's models for the harness in use, over the scan", () => {
    const scanned = { ...CLAUDE, models: [OPUS], model: "opus" };
    const running = { models: [OPUS, SONNET], model: "sonnet" };
    expect(harnessChoices([scanned], "claude", running)[0]).toMatchObject(running);
  });

  it("follows the three with any other harness the host reports", () => {
    const other = { harness: "pi", hint: null } as unknown as HarnessInfo;
    const ids = harnessChoices([CLAUDE, other], "claude", null).map((h) => h.id);
    expect(ids).toEqual(["claude", "codex", "kaava", "pi"]);
  });
});
