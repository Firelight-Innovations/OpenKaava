/**
 * C4: "What did each day cost, by service?" — a stacked bar, one bar per day
 * of the current invoice month, one stack per service
 * (`docs/design/COST-TRACKER-CHARTS.md` §2). Needs the billing export, so this
 * only ever sees `Trends.daily`.
 */
import type { EChartsOption } from "echarts";
import { money } from "../model";
import type { DailyCost } from "../rpc";
import type { ChartTheme } from "./theme";

export function dailyOption(daily: DailyCost[], theme: ChartTheme): EChartsOption {
  const days = [...new Set(daily.map((row) => row.day))].sort();
  const services = [...new Set(daily.map((row) => row.service))];
  const byDayAndService = new Map(daily.map((row) => [`${row.day}\u0000${row.service}`, row.net]));
  const axisLabel = { color: theme.textDim, fontFamily: theme.mono, fontSize: 11 };

  return {
    color: theme.series,
    grid: { left: 56, right: 20, top: 36, bottom: 28 },
    xAxis: {
      type: "category",
      data: days,
      axisLine: { lineStyle: { color: theme.grid } },
      axisLabel: { color: theme.textDim, fontFamily: theme.sans, fontSize: 11 },
    },
    yAxis: {
      type: "value",
      axisLabel: { ...axisLabel, formatter: (value: number) => money(value) },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    legend: {
      data: services,
      textStyle: { color: theme.textDim, fontFamily: theme.sans, fontSize: 11 },
      top: 0,
      right: 0,
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text },
      valueFormatter: (value) => money(Number(value)),
    },
    series: services.map((service) => ({
      name: service,
      type: "bar",
      stack: "day",
      data: days.map((day) => byDayAndService.get(`${day}\u0000${service}`) ?? 0),
    })),
  };
}
