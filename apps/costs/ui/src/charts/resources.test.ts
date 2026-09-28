import { describe, expect, it } from "vitest";
import type { BarSeriesOption } from "echarts";
import { resourcesOption } from "./resources";
import { TEST_THEME } from "./testTheme";
import type { Category, Line } from "../rpc";

/** `yAxis.data` is typed by an echarts interface this package does not export. */
interface CategoryAxis {
  data?: unknown[];
}

const line = (resource: string, forecast: number): Line => ({
  resource,
  detail: `${resource} detail`,
  item: "vCPU",
  quantityToDate: 1,
  quantityForecast: 1,
  unit: "vCPU·h",
  unitPrice: 0.02,
  toDate: forecast * 0.9,
  forecast,
  sku: null,
  note: null,
});

const category = (lines: Line[]): Category => ({
  id: "machines",
  label: "Machines",
  toDate: 0,
  forecast: 0,
  lines,
});

describe("resourcesOption", () => {
  it("draws every resource, biggest at the top, when there are 8 or fewer", () => {
    const categories = [category([line("a", 10), line("b", 30), line("c", 20)])];
    const option = resourcesOption(categories, TEST_THEME);
    const yAxis = option.yAxis as CategoryAxis;
    const [bar] = option.series as BarSeriesOption[];
    expect(yAxis.data).toEqual(["a", "c", "b"]);
    expect(bar.data).toEqual([10, 20, 30]);
  });

  it("folds anything past the top 8 into Other, drawn at the bottom", () => {
    const lines = Array.from({ length: 10 }, (_, i) => line(`r${i}`, 10 - i));
    const categories = [category(lines)];
    const option = resourcesOption(categories, TEST_THEME);
    const yAxis = option.yAxis as CategoryAxis;
    expect(yAxis.data?.[0]).toBe("Other");
    expect(yAxis.data).toHaveLength(9);
    const [bar] = option.series as BarSeriesOption[];
    // r8 (value 2) + r9 (value 1) folded into Other = 3.
    expect(bar.data?.[0]).toBe(3);
  });

  it("groups lines by resource across categories before ranking", () => {
    const categories = [category([line("a", 5)]), category([line("a", 5), line("b", 1)])];
    const option = resourcesOption(categories, TEST_THEME);
    const yAxis = option.yAxis as CategoryAxis;
    expect(yAxis.data).toEqual(["b", "a"]);
    const [bar] = option.series as BarSeriesOption[];
    expect(bar.data).toEqual([1, 10]);
  });
});
