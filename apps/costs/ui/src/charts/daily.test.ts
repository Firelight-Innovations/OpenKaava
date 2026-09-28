import { describe, expect, it } from "vitest";
import type { BarSeriesOption } from "echarts";
import { dailyOption } from "./daily";
import { TEST_THEME } from "./testTheme";
import type { DailyCost } from "../rpc";

interface CategoryAxis {
  data?: unknown[];
}

describe("dailyOption", () => {
  it("stacks one series per service, in days seen across the whole month", () => {
    const daily: DailyCost[] = [
      { day: "2026-09-02", service: "Compute Engine", net: 8 },
      { day: "2026-09-01", service: "Compute Engine", net: 10 },
      { day: "2026-09-01", service: "Cloud Storage", net: 2 },
    ];
    const option = dailyOption(daily, TEST_THEME);
    const xAxis = option.xAxis as CategoryAxis;
    expect(xAxis.data).toEqual(["2026-09-01", "2026-09-02"]);

    const series = option.series as BarSeriesOption[];
    expect(series.map((s) => s.name)).toEqual(["Compute Engine", "Cloud Storage"]);
    expect(series.every((s) => s.stack === "day")).toBe(true);

    const compute = series.find((s) => s.name === "Compute Engine");
    expect(compute?.data).toEqual([10, 8]);
    const storage = series.find((s) => s.name === "Cloud Storage");
    // No Cloud Storage row on 2026-09-02: fills in as 0 rather than gapping the stack.
    expect(storage?.data).toEqual([2, 0]);
  });

  it("draws nothing when there are no rows yet", () => {
    const option = dailyOption([], TEST_THEME);
    expect((option.xAxis as CategoryAxis).data).toEqual([]);
    expect(option.series).toEqual([]);
  });
});
