import { describe, expect, it } from "vitest";
import type { PieSeriesOption } from "echarts";
import { categoriesOption } from "./categories";
import { TEST_THEME } from "./testTheme";
import type { Category } from "../rpc";

const category = (id: Category["id"], label: string, forecast: number): Category => ({
  id,
  label,
  toDate: forecast * 0.9,
  forecast,
  lines: [],
});

describe("categoriesOption", () => {
  it("draws one donut slice per category, named and valued by forecast", () => {
    const categories = [category("machines", "Machines", 60), category("disks", "Disks", 15)];
    const [pie] = categoriesOption(categories, TEST_THEME).series as PieSeriesOption[];
    expect(pie.radius).toEqual(["62%", "88%"]);
    expect(pie.data).toEqual([
      { name: "Machines", value: 60 },
      { name: "Disks", value: 15 },
    ]);
  });

  it("draws no inline labels, leaving the legend list to the surrounding component", () => {
    const [pie] = categoriesOption([category("run", "Cloud Run", 5)], TEST_THEME)
      .series as PieSeriesOption[];
    expect(pie.label?.show).toBe(false);
  });

  it("places the forecast total in the ring's centre via a second, silent slice", () => {
    const categories = [category("machines", "Machines", 60), category("disks", "Disks", 15)];
    const [, centre] = categoriesOption(categories, TEST_THEME).series as PieSeriesOption[];
    expect(centre?.radius).toEqual([0, 0]);
    expect(centre?.silent).toBe(true);
    const formatter = centre?.label?.formatter as (() => string) | undefined;
    expect(formatter?.()).toContain("$75.00");
  });
});
