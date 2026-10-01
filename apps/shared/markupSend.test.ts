/**
 * How a markup reaches the agent, for both viewers that have markup. One
 * implementation, so the two differ only in the key prefix and the label.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@openkaava/bridge", () => ({ invoke }));

import type { MarkupJson } from "@kaava/markup";
import { BLENDER_TARGET, GODOT_TARGET, putMarkup, putMarkupItems, sendMarkup } from "./markupFlow";

const markup: MarkupJson = {
  version: 1,
  source: { kind: "scene", glb: ".kaava/blender/bed.glb" },
  size: { width: 640, height: 360 },
  pins: [{ n: 1, note: "thinner", nodePath: "Bed/Frame" }],
  annotations: [],
  excalidraw: { elements: [], appState: { viewBackgroundColor: "transparent" } },
};
const png = () => new Blob([new Uint8Array([65, 66, 67])]);

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValueOnce({ id: "png" }).mockResolvedValueOnce({ id: "json" });
});

describe("putMarkupItems", () => {
  it.each([
    [GODOT_TARGET, "res://main.tscn", "godot/main.tscn", "Godot"],
    [BLENDER_TARGET, "art/bed.blend", "blender/art/bed.blend", "Blender"],
  ])("keys and labels the items for %j", async (target, subject, key, label) => {
    await putMarkupItems(target, png(), markup, subject);
    expect(invoke).toHaveBeenNthCalledWith(1, "context/put", {
      key: `${key}/markup`,
      kind: "image",
      title: `${subject} - markup`,
      label: `${label} - markup`,
      bytesBase64: "QUJD",
    });
    const second = invoke.mock.calls[1]![1] as Record<string, string>;
    expect(second.key).toBe(`${key}/markup-json`);
    expect(second.kind).toBe("json");
    expect(second.label).toBe(`${label} - markup JSON`);
    expect(JSON.parse(second.text!)).toEqual(markup);
  });

  it("falls back to a generic name when nothing is chosen", async () => {
    await putMarkupItems(BLENDER_TARGET, png(), markup, null);
    expect(invoke.mock.calls[0]![1]).toMatchObject({ key: "blender/scene/markup" });
  });
});

describe("putMarkup", () => {
  it("returns the picture item, for a drag", async () => {
    expect(await putMarkup(BLENDER_TARGET, png(), markup, "bed.blend")).toEqual({ id: "png" });
  });
});

describe("sendMarkup", () => {
  it("types references to both items at the prompt, and nothing more", async () => {
    invoke.mockResolvedValueOnce({ inserted: true });
    const ref = await sendMarkup(BLENDER_TARGET, png(), markup, "bed.blend");
    expect(ref).toEqual({ id: "png" });
    expect(invoke).toHaveBeenLastCalledWith("context/insert", { itemIds: ["png", "json"] });
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("is not a failure when there is no terminal to type into", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    invoke.mockRejectedValueOnce(new Error("no agent terminal"));
    await expect(sendMarkup(GODOT_TARGET, png(), markup, "res://m.tscn")).resolves.toEqual({
      id: "png",
    });
    quiet.mockRestore();
  });
});
