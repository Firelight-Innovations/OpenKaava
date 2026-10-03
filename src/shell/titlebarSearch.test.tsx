// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  activeTitlebarSearch,
  claimTitlebarSearch,
  resetTitlebarSearch,
  useTitlebarSearch,
  type TitlebarSearchClaim,
} from "./titlebarSearch";

const make = (placeholder: string, value = ""): TitlebarSearchClaim => ({
  placeholder,
  value,
  onChange: () => {},
});

afterEach(() => {
  cleanup();
  resetTitlebarSearch();
});

describe("titlebar search claims", () => {
  it("is unclaimed by default", () => {
    expect(activeTitlebarSearch()).toBeNull();
  });

  it("shows a claim and reverts on release", () => {
    const a = claimTitlebarSearch(make("Search settings"));
    expect(activeTitlebarSearch()?.placeholder).toBe("Search settings");
    a.release();
    expect(activeTitlebarSearch()).toBeNull();
  });

  it("lets the most recent claim win and hands back on release", () => {
    const a = claimTitlebarSearch(make("A"));
    const b = claimTitlebarSearch(make("B"));
    expect(activeTitlebarSearch()?.placeholder).toBe("B");
    b.release();
    expect(activeTitlebarSearch()?.placeholder).toBe("A");
    a.release();
    expect(activeTitlebarSearch()).toBeNull();
  });

  it("keeps an older claim's place when it is updated", () => {
    const a = claimTitlebarSearch(make("A"));
    claimTitlebarSearch(make("B"));
    a.update(make("A", "typed"));
    expect(activeTitlebarSearch()?.placeholder).toBe("B");
  });

  it("releasing a buried claim does not disturb the top one", () => {
    const a = claimTitlebarSearch(make("A"));
    claimTitlebarSearch(make("B"));
    a.release();
    expect(activeTitlebarSearch()?.placeholder).toBe("B");
  });
});

describe("useTitlebarSearch", () => {
  function Surface({ claim }: { claim: TitlebarSearchClaim | null }) {
    useTitlebarSearch(claim);
    return null;
  }

  it("claims on mount, tracks value changes and releases on unmount", () => {
    const { rerender, unmount } = render(<Surface claim={make("Search settings")} />);
    expect(activeTitlebarSearch()?.value).toBe("");
    rerender(<Surface claim={make("Search settings", "font")} />);
    expect(activeTitlebarSearch()?.value).toBe("font");
    unmount();
    expect(activeTitlebarSearch()).toBeNull();
  });

  it("does not claim while null and claims when it becomes non-null", () => {
    const { rerender } = render(<Surface claim={null} />);
    expect(activeTitlebarSearch()).toBeNull();
    rerender(<Surface claim={make("Filter tools")} />);
    expect(activeTitlebarSearch()?.placeholder).toBe("Filter tools");
    rerender(<Surface claim={null} />);
    expect(activeTitlebarSearch()).toBeNull();
  });

  it("a later surface takes the field and gives it back when it unmounts", () => {
    render(<Surface claim={make("Search settings")} />);
    const second = render(<Surface claim={make("Filter tools")} />);
    expect(activeTitlebarSearch()?.placeholder).toBe("Filter tools");
    second.unmount();
    expect(activeTitlebarSearch()?.placeholder).toBe("Search settings");
  });

  it("calls the latest onChange", () => {
    const onChange = vi.fn();
    render(<Surface claim={{ placeholder: "x", value: "", onChange }} />);
    act(() => activeTitlebarSearch()?.onChange("hi"));
    expect(onChange).toHaveBeenCalledWith("hi");
  });
});
