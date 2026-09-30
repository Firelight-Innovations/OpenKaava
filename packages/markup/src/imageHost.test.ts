import { describe, expect, it, vi } from "vitest";
import { imageHost } from "./imageHost";

function okFetch(bytes = "png") {
  return vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob([bytes]) }));
}

describe("imageHost", () => {
  it("describes itself as an image with its path", () => {
    const h = imageHost("asset://render.png", {
      path: "renders/room.png",
      size: { width: 1, height: 1 },
    });
    expect(h.describe()).toEqual({ kind: "image", path: "renders/room.png" });
    expect(imageHost("a.png", { size: { width: 1, height: 1 } }).describe()).toEqual({
      kind: "image",
      path: "a.png",
    });
  });

  it("has no geometry: no pick, project or camera", () => {
    const h = imageHost("a.png", { size: { width: 1, height: 1 } });
    expect(h.pick).toBeUndefined();
    expect(h.project).toBeUndefined();
    expect(h.getCamera).toBeUndefined();
    expect(h.setInteractive).toBeUndefined();
  });

  it("reports the natural size once loaded", async () => {
    const h = imageHost("a.png", { loadImage: async () => ({ width: 1920, height: 1080 }) });
    expect(h.size()).toEqual({ width: 0, height: 0 });
    await h.ready;
    expect(h.size()).toEqual({ width: 1920, height: 1080 });
  });

  it("prefers the displayed size, and follows resizes", async () => {
    const load = vi.fn();
    const h = imageHost("a.png", { size: { width: 400, height: 300 }, loadImage: load });
    await h.ready;
    expect(load).not.toHaveBeenCalled();
    expect(h.size()).toEqual({ width: 400, height: 300 });
    h.setSize({ width: 200, height: 150 });
    expect(h.size()).toEqual({ width: 200, height: 150 });
  });

  it("captures the image bytes once", async () => {
    const fetchImpl = okFetch();
    const h = imageHost("a.png", { size: { width: 1, height: 1 }, fetchImpl });
    const [a, b] = await Promise.all([h.capture(), h.capture()]);
    expect(await a.text()).toBe("png");
    expect(b).toBe(a);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects on a failed read and tries again next time", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, blob: async () => new Blob() })
      .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob(["x"]) });
    const h = imageHost("a.png", { size: { width: 1, height: 1 }, fetchImpl });
    await expect(h.capture()).rejects.toThrow(/404/);
    await new Promise((r) => setTimeout(r, 0));
    expect(await (await h.capture()).text()).toBe("x");
  });
});
