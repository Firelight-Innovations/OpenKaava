/**
 * Writes `fixtures/room.glb`: a few named boxes in a hierarchy, one authored
 * camera and one directional light. Small enough to commit (a few KB) and shaped
 * to exercise what the viewer does: `Main/Chair/Leg3` style paths, the glTF
 * camera, KHR_lights_punctual, and two materials.
 *
 * Built by hand rather than with three's GLTFExporter: that exporter reads its
 * binary through `FileReader`, which Node does not have, and a fixture whose
 * generator needs a browser shim is a fixture nobody regenerates.
 *
 *   pnpm --filter @openkaava/scene-view fixture
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "room.glb");

// A unit cube: 24 vertices (4 per face, for flat normals), 36 indices.
const faces = [
  {
    n: [0, 0, 1],
    v: [
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ],
  },
  {
    n: [0, 0, -1],
    v: [
      [1, -1, -1],
      [-1, -1, -1],
      [-1, 1, -1],
      [1, 1, -1],
    ],
  },
  {
    n: [1, 0, 0],
    v: [
      [1, -1, 1],
      [1, -1, -1],
      [1, 1, -1],
      [1, 1, 1],
    ],
  },
  {
    n: [-1, 0, 0],
    v: [
      [-1, -1, -1],
      [-1, -1, 1],
      [-1, 1, 1],
      [-1, 1, -1],
    ],
  },
  {
    n: [0, 1, 0],
    v: [
      [-1, 1, 1],
      [1, 1, 1],
      [1, 1, -1],
      [-1, 1, -1],
    ],
  },
  {
    n: [0, -1, 0],
    v: [
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
      [-1, -1, 1],
    ],
  },
];
const positions = [];
const normals = [];
const indices = [];
faces.forEach((f, fi) => {
  f.v.forEach((p) => {
    positions.push(p[0] * 0.5, p[1] * 0.5, p[2] * 0.5);
    normals.push(...f.n);
  });
  const b = fi * 4;
  indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
});

const normalized = (q) => {
  const len = Math.hypot(...q);
  return q.map((c) => c / len);
};

const posBytes = Buffer.from(new Float32Array(positions).buffer);
const normBytes = Buffer.from(new Float32Array(normals).buffer);
const idxBytes = Buffer.from(new Uint16Array(indices).buffer);
const bin = Buffer.concat([posBytes, normBytes, idxBytes]);

const gltf = {
  asset: { version: "2.0", generator: "scene-view make-fixture" },
  extensionsUsed: ["KHR_lights_punctual"],
  extensions: {
    KHR_lights_punctual: {
      lights: [{ type: "directional", intensity: 3, color: [1, 0.96, 0.9], name: "Sun" }],
    },
  },
  scene: 0,
  scenes: [{ name: "Scene", nodes: [0, 6, 7] }],
  nodes: [
    { name: "Main", children: [1, 4, 5] },
    { name: "Chair", children: [2, 3], translation: [-1, 0, 0] },
    { name: "Seat", mesh: 0, translation: [0, 0.5, 0], scale: [1, 0.15, 1] },
    { name: "Leg3", mesh: 0, translation: [0.4, 0.2, 0.4], scale: [0.2, 0.8, 0.2] },
    { name: "Table", mesh: 1, translation: [1, 0.4, 0], scale: [2, 0.2, 1.5] },
    { name: "Floor", mesh: 1, translation: [0, -0.05, 0], scale: [8, 0.1, 8] },
    {
      name: "Camera",
      camera: 0,
      translation: [4, 3, 5],
      rotation: normalized([-0.2, 0.3, 0.06, 0.93]),
    },
    {
      name: "Sun",
      extensions: { KHR_lights_punctual: { light: 0 } },
      rotation: normalized([-0.5, 0.3, 0.1, 0.8]),
    },
  ],
  meshes: [
    {
      name: "Box",
      primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }],
    },
    {
      name: "Slab",
      primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 1 }],
    },
  ],
  materials: [
    {
      name: "Wood",
      pbrMetallicRoughness: {
        baseColorFactor: [0.55, 0.36, 0.2, 1],
        metallicFactor: 0,
        roughnessFactor: 0.7,
      },
    },
    {
      name: "Plaster",
      pbrMetallicRoughness: {
        baseColorFactor: [0.75, 0.75, 0.72, 1],
        metallicFactor: 0,
        roughnessFactor: 0.9,
      },
    },
  ],
  cameras: [
    { type: "perspective", perspective: { yfov: 0.8, znear: 0.1, zfar: 100, aspectRatio: 1.6 } },
  ],
  accessors: [
    {
      bufferView: 0,
      componentType: 5126,
      count: 24,
      type: "VEC3",
      min: [-0.5, -0.5, -0.5],
      max: [0.5, 0.5, 0.5],
    },
    { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
    { bufferView: 2, componentType: 5123, count: 36, type: "SCALAR" },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 },
    { buffer: 0, byteOffset: posBytes.length, byteLength: normBytes.length, target: 34962 },
    {
      buffer: 0,
      byteOffset: posBytes.length + normBytes.length,
      byteLength: idxBytes.length,
      target: 34963,
    },
  ],
  buffers: [{ byteLength: bin.length }],
};

function pad(buf, byte) {
  const extra = (4 - (buf.length % 4)) % 4;
  return extra ? Buffer.concat([buf, Buffer.alloc(extra, byte)]) : buf;
}
const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
const binPadded = pad(bin, 0);
const total = 12 + 8 + json.length + 8 + binPadded.length;
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(total, 8);
const chunk = (type, data) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(data.length, 0);
  h.writeUInt32LE(type, 4);
  return Buffer.concat([h, data]);
};
writeFileSync(out, Buffer.concat([header, chunk(0x4e4f534a, json), chunk(0x004e4942, binPadded)]));
console.log(`wrote ${out} (${total} bytes)`);
