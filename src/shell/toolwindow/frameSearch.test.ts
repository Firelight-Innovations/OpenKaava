import { afterEach, describe, expect, it, vi } from "vitest";
import { createFrameSearch, declaredSearchClaim } from "./frameSearch";
import { activeTitlebarSearch, claimTitlebarSearch, resetTitlebarSearch } from "../titlebarSearch";

afterEach(() => resetTitlebarSearch());

const claim = { placeholder: "Filter files", value: "" };

describe("declaredSearchClaim", () => {
  it("reads a placeholder and a value", () => {
    expect(declaredSearchClaim({ placeholder: "Filter", value: "a" })).toEqual({
      placeholder: "Filter",
      value: "a",
    });
  });
  it("defaults a missing value and rejects a missing placeholder", () => {
    expect(declaredSearchClaim({ placeholder: "Filter" })?.value).toBe("");
    expect(declaredSearchClaim({ value: "a" })).toBeNull();
    expect(declaredSearchClaim({ placeholder: "  " })).toBeNull();
    expect(declaredSearchClaim(null)).toBeNull();
    expect(declaredSearchClaim("x")).toBeNull();
  });
});

describe("createFrameSearch", () => {
  it("does not show a claim from a frame that is not active", () => {
    const search = createFrameSearch(vi.fn());
    search.setActive(["b"]);
    expect(search.claim("a", claim)).toBe(true);
    expect(activeTitlebarSearch()).toBeNull();
  });

  it("shows the claim once the frame becomes active and hides it when it stops", () => {
    const search = createFrameSearch(vi.fn());
    search.claim("a", claim);
    search.setActive(["a"]);
    expect(activeTitlebarSearch()?.placeholder).toBe("Filter files");
    search.setActive(["b"]);
    expect(activeTitlebarSearch()).toBeNull();
    search.setActive(["a"]);
    expect(activeTitlebarSearch()?.placeholder).toBe("Filter files");
  });

  it("delivers typing, submit and escape to the claiming frame", () => {
    const deliver = vi.fn();
    const search = createFrameSearch(deliver);
    search.setActive(["a"]);
    search.claim("a", claim);
    const shown = activeTitlebarSearch()!;
    shown.onChange("src");
    expect(deliver).toHaveBeenLastCalledWith("a", { kind: "query", value: "src" });
    expect(activeTitlebarSearch()?.value).toBe("src");
    activeTitlebarSearch()?.onSubmit?.();
    expect(deliver).toHaveBeenLastCalledWith("a", { kind: "submit", value: "src" });
    activeTitlebarSearch()?.onEscape?.();
    expect(deliver).toHaveBeenLastCalledWith("a", { kind: "escape", value: "src" });
  });

  it("updates the field when the frame repeats its claim", () => {
    const search = createFrameSearch(vi.fn());
    search.setActive(["a"]);
    search.claim("a", claim);
    search.claim("a", { placeholder: "Filter files", value: "" });
    search.claim("a", { placeholder: "Search nodes", value: "x" });
    expect(activeTitlebarSearch()).toMatchObject({ placeholder: "Search nodes", value: "x" });
  });

  it("release and unmount hand the field back", () => {
    const search = createFrameSearch(vi.fn());
    search.setActive(["a"]);
    search.claim("a", claim);
    search.release("a");
    expect(activeTitlebarSearch()).toBeNull();
  });

  it("rejects a malformed claim without disturbing the existing one", () => {
    const search = createFrameSearch(vi.fn());
    search.setActive(["a"]);
    search.claim("a", claim);
    expect(search.claim("a", { value: "x" })).toBe(false);
    expect(activeTitlebarSearch()?.placeholder).toBe("Filter files");
  });

  it("yields to a shell surface that claimed later, and takes the field back after", () => {
    const search = createFrameSearch(vi.fn());
    search.setActive(["a"]);
    search.claim("a", claim);
    const settings = claimTitlebarSearch({
      placeholder: "Search settings",
      value: "",
      onChange: () => {},
    });
    expect(activeTitlebarSearch()?.placeholder).toBe("Search settings");
    settings.release();
    expect(activeTitlebarSearch()?.placeholder).toBe("Filter files");
  });

  it("a frame activated after a shell surface sits above it", () => {
    const search = createFrameSearch(vi.fn());
    search.claim("a", claim);
    claimTitlebarSearch({ placeholder: "Search settings", value: "", onChange: () => {} });
    search.setActive(["a"]);
    expect(activeTitlebarSearch()?.placeholder).toBe("Filter files");
  });
});
