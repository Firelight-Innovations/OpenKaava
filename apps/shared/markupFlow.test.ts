import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@openkaava/bridge", () => ({ invoke }));

import {
  AUTO_SEND_KEY,
  TIP_KEY,
  afterDone,
  markupSummary,
  offerAutomatic,
  prefsFrom,
  readPrefs,
  setPref,
} from "./markupFlow";

const groups = [
  {
    settings: [
      { key: AUTO_SEND_KEY, control: { default: false } },
      { key: TIP_KEY, control: { default: true } },
    ],
  },
];

beforeEach(() => {
  invoke.mockReset();
});

describe("prefsFrom", () => {
  it("reads a key that is absent as its shipped default, not as false", () => {
    expect(prefsFrom({ groups, values: {} })).toEqual({ auto: false, tip: true });
  });

  it("takes a stored value over the default", () => {
    expect(prefsFrom({ groups, values: { [AUTO_SEND_KEY]: true, [TIP_KEY]: false } })).toEqual({
      auto: true,
      tip: false,
    });
  });
});

describe("readPrefs", () => {
  it("keeps markup manual and the offer quiet when the host cannot answer", async () => {
    invoke.mockImplementation(() => {
      throw new Error("no host");
    });
    expect(await readPrefs()).toEqual({ auto: false, tip: false });
  });
});

describe("setPref", () => {
  it("writes through settings/set", async () => {
    invoke.mockResolvedValue(true);
    await setPref(AUTO_SEND_KEY, true);
    expect(invoke).toHaveBeenCalledWith("settings/set", { key: AUTO_SEND_KEY, value: true });
  });
});

describe("afterDone", () => {
  it("sends at once only when the setting is on", () => {
    expect(afterDone({ auto: true, tip: true })).toBe("send");
    expect(afterDone({ auto: false, tip: true })).toBe("keep");
  });
});

describe("offerAutomatic", () => {
  it("offers once, until the person opts out or it is already automatic", () => {
    expect(offerAutomatic({ auto: false, tip: true }, false)).toBe(true);
    expect(offerAutomatic({ auto: false, tip: true }, true)).toBe(false);
    expect(offerAutomatic({ auto: false, tip: false }, false)).toBe(false);
    expect(offerAutomatic({ auto: true, tip: true }, false)).toBe(false);
  });
});

describe("markupSummary", () => {
  it("counts pins and marks", () => {
    expect(markupSummary({ pins: [{ n: 1, note: "a" }], annotations: [] })).toBe("1 pin");
    expect(markupSummary({ pins: [], annotations: [] })).toBe("empty");
  });
});
