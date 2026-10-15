import { describe, expect, it } from "vitest";
import { hintText, infoOf, modelName } from "./harness";
import type { HarnessInfo, Hint, SessionStatus } from "./protocol.generated";

/**
 * A harness the registry might list one day, so no sentence can hide behind
 * Claude's words. Its id is Claude's only because `Harness` has one variant.
 */
const PI: HarnessInfo = {
  harness: "claude",
  name: "Pi",
  hint: "signedOut",
  setup: {
    cli: "pi",
    signIn: "pi login",
    adapterInstall: "npm i -g --omit=optional pi-acp@1.2.3",
    adapterVersion: "1.2.3",
  },
  capabilities: { steer: false, fork: false, modes: true },
  models: null,
  model: null,
};

const status = (config: SessionStatus["config"]): SessionStatus => ({
  state: "ready",
  harness: "claude",
  cwd: "C:/wt/x",
  mode: "default",
  modes: [],
  config,
  adapterVersion: "1.2.3",
  exitCode: null,
  hint: null,
  pendingPrompt: null,
  answered: 0,
  settingTrouble: null,
});

describe("hint sentences", () => {
  it("name the harness and its own setup commands", () => {
    expect(hintText("harnessMissing", PI)).toContain("Pi is not installed");
    expect(hintText("harnessMissing", PI)).toContain("`pi login`");
    expect(hintText("signedOut", PI)).toContain("Pi is not signed in. Run `pi login`");
    expect(hintText("adapterMissing", PI)).toContain("The Pi ACP adapter");
    expect(hintText("adapterMissing", PI)).toContain("`npm i -g --omit=optional pi-acp@1.2.3`");
    expect(hintText("adapterVersion", PI)).toContain("tested with adapter 1.2.3");
  });

  it("never name Claude for another harness", () => {
    for (const hint of [
      "harnessMissing",
      "adapterMissing",
      "signedOut",
      "adapterVersion",
    ] as const) {
      expect(hintText(hint, PI)).not.toMatch(/claude/i);
    }
  });

  it("stay neutral before the tab knows the harness", () => {
    expect(hintText("signedOut", undefined)).toBe("The agent is not ready to run.");
  });

  it("stay neutral for a hint this build does not know", () => {
    expect(hintText("rateLimited" as Hint, PI)).toBe("The agent is not ready to run.");
    expect(hintText("toString" as Hint, PI)).toBe("The agent is not ready to run.");
  });
});

describe("the registry's answer", () => {
  it("finds a harness's info by its id, and nothing for none", () => {
    expect(infoOf([PI], "claude")).toBe(PI);
    expect(infoOf([PI], null)).toBeUndefined();
  });
});

describe("the running model", () => {
  const model = (value: string) => ({
    id: "model",
    name: "Model",
    description: null,
    category: "model",
    value,
    choices: [{ value: "opus", name: "Opus", description: null }],
  });

  it("is the agent's label for the value of its model option", () => {
    expect(modelName(status([model("opus")]))).toBe("Opus");
  });

  it("is the bare value when the agent offers no label for it", () => {
    expect(modelName(status([model("haiku")]))).toBe("haiku");
  });

  it("is unknown without a session or a model option", () => {
    expect(modelName(null)).toBeNull();
    expect(modelName(status([{ ...model("opus"), category: "thought_level" }]))).toBeNull();
  });
});
