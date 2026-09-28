import { describe, expect, it } from "vitest";
import type {
  BarSeriesOption,
  DefaultLabelFormatterCallbackParams,
  TooltipComponentFormatterCallbackParams,
} from "echarts";
import { monthlyOption } from "./monthly";
import { TEST_THEME } from "./testTheme";
import type { MonthlyCost } from "../rpc";

interface CategoryAxis {
  data?: unknown[];
}

const rows: MonthlyCost[] = [
  { month: "202607", net: 100, partial: false },
  { month: "202608", net: 110, partial: false },
  { month: "202609", net: 40, partial: true },
];

describe("monthlyOption", () => {
  it("labels months short-form, oldest first", () => {
    const option = monthlyOption(rows, TEST_THEME);
    expect((option.xAxis as CategoryAxis).data).toEqual(["Jul", "Aug", "Sep"]);
  });

  it("carries each month's net cost, fading the still-running month", () => {
    const [bar] = monthlyOption(rows, TEST_THEME).series as BarSeriesOption[];
    const data = bar.data as { value: number; itemStyle?: { opacity?: number } }[];
    expect(data.map((d) => d.value)).toEqual([100, 110, 40]);
    expect(data[0].itemStyle).toBeUndefined();
    expect(data[2].itemStyle?.opacity).toBe(0.5);
  });

  it("marks the partial month in its tooltip text", () => {
    const option = monthlyOption(rows, TEST_THEME);
    const tooltip = option.tooltip as {
      formatter?: (p: TooltipComponentFormatterCallbackParams) => string;
    };
    const row = { name: "Sep", value: 40, dataIndex: 2 } as DefaultLabelFormatterCallbackParams;
    const text = tooltip.formatter?.([row] as TooltipComponentFormatterCallbackParams);
    expect(text).toBe("Sep: $40.00 (partial)");
  });
});
