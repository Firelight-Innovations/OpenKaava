import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { countTriangles, hasPunctualLights } from "./limits";
import { findByPath, nodePath } from "./nodePath";

const file = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "room.glb");

/**
 * The committed fixture, parsed by the real loader. This is the one place the
 * tested modules meet real `GLTFLoader` output (name sanitising, the camera
 * list, light nodes) without needing a GL context: parsing is CPU only.
 */
describe("fixtures/room.glb", async () => {
  const bytes = readFileSync(file);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new GLTFLoader().parseAsync(buffer as ArrayBuffer, "");

  it("parses with its camera and light", () => {
    expect(gltf.cameras).toHaveLength(1);
    expect(hasPunctualLights(gltf.scene)).toBe(true);
  });

  it("gives nested nodes the slash paths the viewer reports", () => {
    const leg = findByPath(gltf.scene, "Main/Chair/Leg3");
    expect(leg).not.toBeNull();
    expect(nodePath(leg!, gltf.scene)).toBe("Main/Chair/Leg3");
  });

  it("has four boxes' worth of triangles", () => {
    expect(countTriangles(gltf.scene)).toBe(48);
  });
});
