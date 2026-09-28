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
  const total = categories.reduce((sum, c) => sum + c.forecast, 0);
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
      // A second, silent single-slice pie drawn at radius zero, purely to
      // place the forecast total in the ring's centre — the usual ECharts
      // donut-centre-text trick, and no extra component to register for it.
      {
        type: "pie",
        radius: [0, 0],
        silent: true,
        tooltip: { show: false },
        label: {
          show: true,
          position: "center",
          formatter: () => `{big|${money(total)}}\n{small|forecast}`,
          rich: {
            big: { color: theme.text, fontFamily: theme.mono, fontSize: 18, lineHeight: 22 },
            small: { color: theme.textDim, fontFamily: theme.sans, fontSize: 11 },
          },
        },
        data: [{ name: "total", value: 1 }],
      },
    ],
  };
}
