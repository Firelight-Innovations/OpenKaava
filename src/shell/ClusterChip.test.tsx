// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import ClusterChip from "./ClusterChip";
import { iconColorOf, looksLikeEmoji } from "./clusterIcon";

afterEach(cleanup);

describe("ClusterChip", () => {
  it("draws the initials by default, untinted", () => {
    const { container } = render(<ClusterChip cluster={{ name: "godot-port" }} />);
    const chip = container.querySelector(".cluster-chip");
    expect(chip?.textContent).toBe("GP");
    expect(chip?.getAttribute("data-kind")).toBe("initials");
    expect(chip?.hasAttribute("data-icon-color")).toBe(false);
  });

  it("draws the emoji instead of the initials, on its tint", () => {
    const { container } = render(
      <ClusterChip cluster={{ name: "auth", icon: { emoji: "🔥", color: "coral" } }} />,
    );
    const chip = container.querySelector(".cluster-chip");
    expect(chip?.textContent).toBe("🔥");
    expect(chip?.getAttribute("data-kind")).toBe("emoji");
    expect(chip?.getAttribute("data-icon-color")).toBe("coral");
  });

  it("keeps the initials when the icon is only a tint", () => {
    const { container } = render(
      <ClusterChip cluster={{ name: "auth", icon: { emoji: "", color: "green" } }} />,
    );
    const chip = container.querySelector(".cluster-chip");
    expect(chip?.textContent).toBe("AU");
    expect(chip?.getAttribute("data-icon-color")).toBe("green");
  });

  it("falls back to neutral for a colour key it does not know", () => {
    expect(iconColorOf({ emoji: "🔥", color: "chartreuse" })).toBeUndefined();
    expect(iconColorOf(null)).toBeUndefined();
  });

  it("accepts an emoji but not a word as a typed icon", () => {
    expect(looksLikeEmoji("🚀")).toBe(true);
    expect(looksLikeEmoji(" 👨‍👩‍👧 ")).toBe(true);
    expect(looksLikeEmoji("rocket")).toBe(false);
    expect(looksLikeEmoji("")).toBe(false);
  });
});
