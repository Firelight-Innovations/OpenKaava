/**
 * Sample data for the "Preview with sample data" toggle — off by default,
 * per the workstream brief's one allowed exception to "never fake data as
 * real": reviewing this layout against board fixtures before a real
 * `godot --headless` run exists to drive it. Never used unless the toggle is on.
 */
import type { GodotNode, GodotViewerState } from "./rpc";

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
        children: [
          { path: "World/Player/Camera3D", name: "Camera3D", type: "Camera3D", children: [] },
          {
            path: "World/Player/Flashlight",
            name: "Flashlight",
            type: "SpotLight3D",
            children: [],
          },
        ],
      },
      {
        path: "World/HospitalWing",
        name: "HospitalWing",
        type: "Node3D",
        children: [
          {
            path: "World/HospitalWing/Bed01",
            name: "Bed01",
            type: "MeshInstance3D",
            children: [],
          },
          {
            path: "World/HospitalWing/DoorFront",
            name: "DoorFront",
            type: "AnimatableBody3D",
            children: [],
          },
        ],
      },
    ],
  },
];

export const sampleState: GodotViewerState = {
  project: ".",
  scenes: ["res://scenes/hospital_wing.tscn"],
  scene: "res://scenes/hospital_wing.tscn",
  renderedAt: Date.now() - 3 * 60_000,
  scenePath: "res://scenes/hospital_wing.tscn",
  nodes,
  source: "headless",
  godot: "4.3.stable",
  note: null,
  imageAt: null,
  job: null,
  engineFound: true,
};
