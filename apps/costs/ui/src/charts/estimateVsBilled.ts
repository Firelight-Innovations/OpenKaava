/**
 * C6: "Is the estimate close to the bill?" — a grouped bar, one pair per
 * service: the estimate beside what the export actually billed
 * (`docs/design/COST-TRACKER-CHARTS.md` §2, §3.3). Needs the billing export,
 * so this only ever sees `Billed.services`.
 */
import type { EChartsOption } from "echarts";
import { CATEGORY_SERVICE, money } from "../model";
import type { Category, ServiceCost } from "../rpc";
import type { ChartTheme } from "./theme";

export interface EstimateVsBilledRow {
  service: string;
  estimate: number;
  billed: number;
}

/**
 * One row per service that either the estimate models or the bill lists.
 * Estimate categories fold into their mapped service (`CATEGORY_SERVICE`
 * in `model.ts`) — Compute Engine covers three. A billed service with no
 * mapped category gets an estimate of 0: "not estimated", per §3.3.
 */
export function estimateVsBilledRows(
  categories: Category[],
  services: ServiceCost[],
): EstimateVsBilledRow[] {
  const estimateByService = new Map<string, number>();
  for (const category of categories) {
    const service = CATEGORY_SERVICE[category.id];
    estimateByService.set(service, (estimateByService.get(service) ?? 0) + category.forecast);
  }
  const billedByService = new Map(services.map((s) => [s.service, s.net]));
  const names = [...new Set([...estimateByService.keys(), ...billedByService.keys()])];
  return names.map((service) => ({
    service,
    estimate: estimateByService.get(service) ?? 0,
    billed: billedByService.get(service) ?? 0,
  }));
}

export function estimateVsBilledOption(
  rows: EstimateVsBilledRow[],
  theme: ChartTheme,
): EChartsOption {
  const axisLabel = { color: theme.textDim, fontFamily: theme.mono, fontSize: 11 };

  return {
    color: theme.series,
    grid: { left: 56, right: 20, top: 36, bottom: 28 },
    xAxis: {
      type: "category",
      data: rows.map((r) => r.service),
      axisLine: { lineStyle: { color: theme.grid } },
      axisLabel: { color: theme.textDim, fontFamily: theme.sans, fontSize: 11 },
    },
    yAxis: {
      type: "value",
      axisLabel: { ...axisLabel, formatter: (value: number) => money(value) },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    legend: {
      data: ["Estimate", "Billed"],
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
    series: [
      {
        name: "Estimate",
        type: "bar",
        data: rows.map((r) => r.estimate),
        itemStyle: { color: theme.series[0] },
      },
      {
        name: "Billed",
        type: "bar",
        data: rows.map((r) => r.billed),
        itemStyle: { color: theme.series[1] },
      },
    ],
  };
}
