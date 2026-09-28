import { describe, expect, it } from "vitest";
import type { LineSeriesOption, MarkLineComponentOption } from "echarts";
import { burnOption, type BurnInput } from "./burn";
import { TEST_THEME } from "./testTheme";

const base: BurnInput = {
  toDate: 90,
  forecast: 120,
  budget: 150,
  monthStart: "2026-09-01T00:00:00Z",
  now: "2026-09-20T00:00:00Z",
  monthEnd: "2026-10-01T00:00:00Z",
  daily: null,
};

function series(option: ReturnType<typeof burnOption>): LineSeriesOption[] {
  return option.series as LineSeriesOption[];
}

describe("burnOption", () => {
  it("draws the estimate as exactly two points, labelled estimated", () => {
    const [spent] = series(burnOption(base, TEST_THEME));
    expect(spent.name).toBe("Spent, estimated");
    expect(spent.data).toEqual([
      ["2026-09-01T00:00:00Z", 0],
      ["2026-09-20T00:00:00Z", 90],
    ]);
  });

  it("draws exported daily rows as a real cumulative line, summed across services", () => {
    const input: BurnInput = {
      ...base,
      daily: [
        { day: "2026-09-01", service: "Compute Engine", net: 10 },
        { day: "2026-09-01", service: "Cloud Storage", net: 2 },
        { day: "2026-09-02", service: "Compute Engine", net: 8 },
      ],
    };
    const [spent] = series(burnOption(input, TEST_THEME));
    expect(spent.name).toBe("Spent");
    expect(spent.data).toEqual([
      ["2026-09-01", 12],
      ["2026-09-02", 20],
    ]);
  });

  it("dashes the forecast segment from the last actual point to month end", () => {
    const [, forecast] = series(burnOption(base, TEST_THEME));
    expect(forecast.name).toBe("Forecast");
    expect(forecast.data).toEqual([
      ["2026-09-20T00:00:00Z", 90],
      ["2026-10-01T00:00:00Z", 120],
    ]);
    expect(forecast.lineStyle?.type).toBe("dashed");
  });

  it("draws the budget as a horizontal markLine at the budget value", () => {
    const [, , budget] = series(burnOption(base, TEST_THEME));
    const markLine = budget.markLine as MarkLineComponentOption;
    expect(markLine.data).toEqual([{ yAxis: 150 }]);
  });
});
