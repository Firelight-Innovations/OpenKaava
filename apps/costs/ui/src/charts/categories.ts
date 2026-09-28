/**
 * C2: "Where does the money go?" — a donut of forecast by category
 * (`docs/design/COST-TRACKER-CHARTS.md` §2). Draws the ring only; the swatch
 * / name / `$` / `%` legend list beside it is plain DOM in `CostCharts.tsx`,
 * reading the same `categories` array, since it needs exact figures rather
 * than ECharts' own legend text.
 */
import type { EChartsOption } from "echarts";
import { money } from "../model";
import type { Category } from "../rpc";
import type { ChartTheme } from "./theme";

export function categoriesOption(categories: Category[], theme: ChartTheme): EChartsOption {
  return {
    color: theme.series,
    tooltip: {
      trigger: "item",
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text },
      valueFormatter: (value) => money(Number(value)),
    },
    series: [
      {
        type: "pie",
        radius: ["62%", "88%"],
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        data: categories.map((c) => ({ name: c.label, value: c.forecast })),
      },
    ],
  };
}
