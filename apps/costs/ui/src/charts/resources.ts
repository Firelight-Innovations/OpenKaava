/**
 * C3: "Which resources cost the most?" — the top 8 resources by forecast, the
 * rest folded into "Other" (`docs/design/COST-TRACKER-CHARTS.md` §2), reusing
 * `byResource` from `model.ts` so this groups lines exactly as the tables do.
 */
import type { DefaultLabelFormatterCallbackParams, EChartsOption } from "echarts";
import { byResource, money } from "../model";
import type { Category } from "../rpc";
import type { ChartTheme } from "./theme";

const TOP = 8;

interface Bar {
  resource: string;
  forecast: number;
}

export function resourcesOption(categories: Category[], theme: ChartTheme): EChartsOption {
  const groups = byResource(categories.flatMap((c) => c.lines)).sort(
    (a, b) => b.forecast - a.forecast,
  );
  const top: Bar[] = groups
    .slice(0, TOP)
    .map((g) => ({ resource: g.resource, forecast: g.forecast }));
  const other = groups.slice(TOP).reduce((sum, g) => sum + g.forecast, 0);
  const rows = other > 0 ? [...top, { resource: "Other", forecast: other }] : top;
  // The category axis draws its first entry at the bottom, so the chart
  // needs the biggest resource on top — the reverse of `rows`' own order.
  const drawn = [...rows].reverse();

  return {
    color: theme.series,
    grid: { left: 148, right: 64, top: 8, bottom: 8 },
    xAxis: { type: "value", show: false },
    yAxis: {
      type: "category",
      data: drawn.map((r) => r.resource),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: theme.textDim, fontFamily: theme.mono, fontSize: 11 },
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "none" },
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text },
      valueFormatter: (value) => money(Number(value)),
    },
    series: [
      {
        type: "bar",
        data: drawn.map((r) => r.forecast),
        barWidth: 10,
        itemStyle: { color: theme.series[0], borderRadius: 2 },
        label: {
          show: true,
          position: "right",
          color: theme.text,
          fontFamily: theme.mono,
          fontSize: 11,
          formatter: (p: DefaultLabelFormatterCallbackParams) => money(Number(p.value)),
        },
      },
    ],
  };
}
