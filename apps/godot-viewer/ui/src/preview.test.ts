import { describe, expect, it, vi } from "vitest";
import {
  loadPreview,
  nodeLookup,
  PreviewFailure,
  projectRelative,
  type PreviewIo,
} from "./preview";
import type { PreviewAnswer } from "./rpc";

function answer(over: Partial<PreviewAnswer>): PreviewAnswer {
  return {
    status: "ready",
    scene: "res://main.tscn",
    cached: false,
    path: "C:\\proj\\.kaava\\preview\\godot\\main_tscn.glb",
    exportedAt: 7,
    godot: "4.7.2.stable",
    bytes: 3,
    nodeMap: { Main: "Main" },
    phase: null,
    error: null,
    output: [],
    ...over,
  };
}

function io(answers: PreviewAnswer[]): PreviewIo & { forced: boolean[] } {
  const forced: boolean[] = [];
  return {
    forced,
    request: vi.fn(async (force: boolean) => {
      forced.push(force);
      return answers.shift() ?? answer({ status: "failed", error: "ran out of answers" });
    }),
    bytes: vi.fn(async () => ({ base64: btoa("glb") })),
    sleep: vi.fn(async () => {}),
  };
}

describe("loadPreview", () => {
  it("returns a cached preview at once, without sleeping", async () => {
    const backend = io([answer({ cached: true })]);
    const loaded = await loadPreview(backend, { signal: new AbortController().signal });
    expect(new Uint8Array(loaded.glb)).toEqual(new Uint8Array([103, 108, 98]));
    expect(loaded.nodeMap).toEqual({ Main: "Main" });
    expect(backend.sleep).not.toHaveBeenCalled();
  });

  it("polls while the export runs, reporting each phase, and forces only the first ask", async () => {
    const backend = io([
      answer({ status: "running", phase: "importing resources", nodeMap: null, path: null }),
      answer({ status: "running", phase: "exporting the scene to glTF", nodeMap: null }),
      answer({}),
    ]);
    const phases: string[] = [];
    await loadPreview(backend, {
      signal: new AbortController().signal,
      force: true,
      onPhase: (p) => phases.push(p),
    });
    expect(phases).toEqual(["importing resources", "exporting the scene to glTF"]);
    expect(backend.forced).toEqual([true, false, false]);
  });

  it("throws the backend's reason, with Godot's output, when the export fails", async () => {
    const backend = io([
      answer({ status: "failed", error: "could not load", output: ["ERROR: x"] }),
    ]);
    await expect(
      loadPreview(backend, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      name: "PreviewFailure",
      message: "could not load",
      output: ["ERROR: x"],
    });
    expect(backend.bytes).not.toHaveBeenCalled();
  });

  it("refuses a ready answer that does not say where the file is", async () => {
    const backend = io([answer({ path: null })]);
    await expect(
      loadPreview(backend, { signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(PreviewFailure);
  });

  it("stops asking once it is cancelled", async () => {
    const controller = new AbortController();
    const backend = io([answer({ status: "running", nodeMap: null })]);
    backend.sleep = vi.fn(async () => controller.abort());
    await expect(loadPreview(backend, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(backend.request).toHaveBeenCalledTimes(1);
  });

  it("gives up on an export that never finishes", async () => {
    const forever = io([]);
    forever.request = vi.fn(async () => answer({ status: "running", nodeMap: null }));
    await expect(
      loadPreview(forever, { signal: new AbortController().signal, pollMs: 100, maxWaitMs: 300 }),
    ).rejects.toThrow("did not finish");
    expect(forever.request).toHaveBeenCalledTimes(4);
  });
});

describe("nodeLookup", () => {
  const map = {
    Main: "Main",
    "Main/Crate": "Main/Crate",
    "Main/Crate/Crate2": "Main/Crate/Crate",
    "Main/Front_Door": "Main/Front Door",
  };
  const lookup = nodeLookup(map);

  it("maps a pick to its scene path and a tree click to its 3D path", () => {
    expect(lookup.toScene("Main/Crate/Crate2")).toBe("Main/Crate/Crate");
    expect(lookup.toView("Main/Crate/Crate")).toBe("Main/Crate/Crate2");
    expect(lookup.toView("Main/Front Door")).toBe("Main/Front_Door");
  });

  it("falls back to the nearest ancestor that maps", () => {
    expect(lookup.toView("Main/CanvasLayer/Hud/Label")).toBe("Main");
    expect(lookup.toScene("Main/Crate/Unknown/Part")).toBe("Main/Crate");
  });

  it("maps nothing to nothing, and a stranger to nothing", () => {
    expect(lookup.toScene(null)).toBeNull();
    expect(lookup.toView(null)).toBeNull();
    expect(lookup.toView("Elsewhere/Thing")).toBeNull();
  });
});

describe("projectRelative", () => {
  it("names the glb from .kaava down, whatever the separators", () => {
    expect(projectRelative("C:\\p\\.kaava\\preview\\godot\\m.glb")).toBe(
      ".kaava/preview/godot/m.glb",
    );
    expect(projectRelative("C:\\AppData\\preview\\m.glb")).toBe("C:/AppData/preview/m.glb");
  });
});
