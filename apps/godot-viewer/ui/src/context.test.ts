import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@openkaava/bridge", () => ({ invoke }));

import { putFrame, treeText } from "./context";
import type { GodotNode } from "./rpc";

const nodes: GodotNode[] = [
  {
    path: "World",
    name: "World",
    type: "Node3D",
    children: [
      {
        path: "World/Player",
        name: "Player",
        type: "CharacterBody3D",
        script: "res://player.gd",
        children: [],
      },
      {
        path: "World/Wing",
        name: "Wing",
        type: "Node3D",
        instance: "res://wing.tscn",
        children: [],
      },
    ],
  },
];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ id: "ctx-1" });
});

describe("treeText", () => {
  it("indents by depth and names the script or scene behind a node", () => {
    expect(
      treeText({ scenePath: "res://main.tscn", source: "headless", nodes }).split("\n"),
    ).toEqual([
      "Godot scene res://main.tscn (read by Godot)",
      "World (Node3D)",
      "  Player (CharacterBody3D) - script res://player.gd",
      "  Wing (Node3D) - scene res://wing.tscn",
    ]);
  });

  it("says when the tree came from the scene file", () => {
    expect(treeText({ scenePath: "res://m.tscn", source: "parsed", nodes: [] })).toContain(
      "read from the scene file",
    );
  });
});

describe("putFrame", () => {
  it("sends the frame as an image with its bytes", async () => {
    await putFrame("QUJD", "res://main.tscn");
    expect(invoke).toHaveBeenCalledWith("context/put", {
      key: "godot/main.tscn/frame",
      kind: "image",
      title: "res://main.tscn - rendered view",
      label: "Godot - rendered view",
      bytesBase64: "QUJD",
    });
  });
});
