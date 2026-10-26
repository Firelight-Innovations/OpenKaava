/**
 * `defaultSeam.loadGraph`'s own forwarding, isolated from `backend.ts`'s
 * real body entirely — `./backend` is mocked out, not just
 * `@veistra/bridge`, so this test can fail for exactly 1 reason:
 * `index.ts`'s own wrapper arrow drops or mismatches an argument before it
 * reaches the seam it obtains. That is the round-2 defect: a 0-arg arrow
 * satisfying a 2-arg interface with no type error, 1 layer above the
 * `backend.ts` fix `backend.test.ts` proves separately. Asserting on the
 * spy's own call arguments — not on a returned graph's shape — is the
 * direct form of that proof: the backend received the exact values, not
 * merely "was called" or "returned something plausible".
 */
import { describe, expect, it, vi } from "vitest";

describe("defaultSeam.loadGraph", () => {
  it("forwards the exact tier and slug it was called with to the backend seam", async () => {
    const loadGraphSpy = vi.fn().mockResolvedValue({
      tier: "module",
      serviceSlug: "token-verifier",
      serviceTitle: "Token Verifier",
      nodes: [],
      edges: [],
    });
    vi.doMock("./backend", () => ({
      createBackendSeam: () => ({
        loadGraph: loadGraphSpy,
        loadDenseGraph: vi.fn(),
        readLayout: vi.fn(),
        writeLayout: vi.fn(),
        writeSemantic: vi.fn(),
        removeSemantic: vi.fn(),
      }),
    }));

    const { defaultSeam } = await import("./index");
    await defaultSeam.loadGraph("module", "token-verifier");

    expect(loadGraphSpy).toHaveBeenCalledTimes(1);
    expect(loadGraphSpy).toHaveBeenCalledWith("module", "token-verifier");
  });
});
