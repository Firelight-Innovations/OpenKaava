// @vitest-environment jsdom
/**
 * `useGitStatus` re-asks when the cluster is repointed, not only when a
 * different cluster is chosen.
 *
 * The regression: the agent server's `set_project` pointed the active cluster
 * at another project, and Source Control kept describing the old repository
 * until a reload, because the cluster's id — the only thing this hook was
 * keyed on — had not changed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { GitControl, GitStatus } from "../contract";
import { useGitStatus } from "./useGitStatus";

afterEach(cleanup);

function control(): GitControl & { status: ReturnType<typeof vi.fn> } {
  const status = vi.fn(() => Promise.resolve(null as unknown as GitStatus));
  return { status } as unknown as GitControl & { status: ReturnType<typeof vi.fn> };
}

describe("useGitStatus", () => {
  it("re-asks when the cluster's root changes under the same id", async () => {
    const git = control();
    const { rerender } = renderHook(({ root }) => useGitStatus(git, "cluster-1", root), {
      initialProps: { root: "C:/old" as string | null },
    });
    await waitFor(() => expect(git.status).toHaveBeenCalledTimes(1));

    rerender({ root: "C:/new" });
    await waitFor(() => expect(git.status).toHaveBeenCalledTimes(2));
    expect(git.status).toHaveBeenLastCalledWith("cluster-1");
  });

  it("does not re-ask when nothing it is keyed on changed", async () => {
    const git = control();
    const { rerender } = renderHook(({ root }) => useGitStatus(git, "cluster-1", root), {
      initialProps: { root: "C:/same" as string | null },
    });
    await waitFor(() => expect(git.status).toHaveBeenCalledTimes(1));

    rerender({ root: "C:/same" });
    expect(git.status).toHaveBeenCalledTimes(1);
  });
});
