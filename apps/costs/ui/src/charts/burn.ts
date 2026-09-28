/**
 * C1: "Will this month land under budget?" — cumulative spend to today,
 * forecast to month end, and the budget as a horizontal line
 * (`docs/design/COST-TRACKER-CHARTS.md` §2).
 *
 * The estimate alone gives two real points: the month starts at zero, and
 * "now" is `toDate`. That is drawn as exactly two points, never a made-up
 * daily curve. Once `costs/trends` has daily rows for this month, they
 * replace the solid segment with the export's own cumulative line.
 */
import type { EChartsOption } from "echarts";
import { money } from "../model";
import type { DailyCost } from "../rpc";
import type { ChartTheme } from "./theme";

export interface BurnInput {
  toDate: number;
  forecast: number;
  budget: number;
  monthStart: string;
  now: string;
  monthEnd: string;
  /** This invoice month's rows from `costs/trends`, or `null` before it answers. */
  daily: DailyCost[] | null;
}

type Point = [string, number];

/** Net summed across services, running total by day, in day order. */
function cumulative(daily: DailyCost[]): Point[] {
  const byDay = new Map<string, number>();
  for (const row of daily) byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.net);
  let running = 0;
  return [...byDay.keys()].sort().map((day) => {
    running += byDay.get(day) ?? 0;
    return [day, running];
  });
}

export function burnOption(input: BurnInput, theme: ChartTheme): EChartsOption {
  const exported = input.daily && input.daily.length > 0 ? cumulative(input.daily) : null;
  const spentName = exported ? "Spent" : "Spent, estimated";
  const actual: Point[] = exported ?? [
    [input.monthStart, 0],
    [input.now, input.toDate],
  ];
  const last = actual[actual.length - 1] ?? [input.monthStart, 0];
  const axisLabel = { color: theme.textDim, fontFamily: theme.mono, fontSize: 11 };
  return {
    color: theme.series,
    grid: { left: 56, right: 20, top: 36, bottom: 28 },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: theme.grid } },
      axisLabel: { color: theme.textDim, fontFamily: theme.sans, fontSize: 11 },
    },
    yAxis: {
      type: "value",
      axisLabel: { ...axisLabel, formatter: (value: number) => money(value) },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    legend: {
      data: [spentName, "Forecast", "Budget"],
      textStyle: { color: theme.textDim, fontFamily: theme.sans, fontSize: 11 },
      top: 0,
      right: 0,
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text },
      valueFormatter: (value) => money(Number(value)),
    },
    series: [
      {
        name: spentName,
        type: "line",
        data: actual,
        symbolSize: 6,
        lineStyle: { width: 2.5, color: theme.series[0] },
        itemStyle: { color: theme.series[0] },
      },
      {
        name: "Forecast",
        type: "line",
        data: [last, [input.monthEnd, input.forecast]],
        symbol: "none",
        lineStyle: { width: 2.5, type: "dashed", color: theme.series[0] },
      },
      {
        name: "Budget",
        type: "line",
        data: [],
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: theme.tones.err, type: "dashed" },
          label: { formatter: `Budget ${money(input.budget)}`, color: theme.tones.err },
          data: [{ yAxis: input.budget }],
        },
      },
    ],
  };
}
