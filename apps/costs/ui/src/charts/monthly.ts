/**
 * C5: "How does this month compare with earlier ones?" — the last six invoice
 * months' net cost, with the current, still-running month drawn lighter and
 * labelled "partial" (`docs/design/COST-TRACKER-CHARTS.md` §2).
 */
import type { EChartsOption, TooltipComponentFormatterCallbackParams } from "echarts";
import { money } from "../model";
import type { MonthlyCost } from "../rpc";
import type { ChartTheme } from "./theme";

/** `202609` -> `Sep`. */
function monthLabel(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(4, 6)) - 1;
  return new Date(Date.UTC(year, monthIndex, 1)).toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
}

export function monthlyOption(monthly: MonthlyCost[], theme: ChartTheme): EChartsOption {
  const axisLabel = { color: theme.textDim, fontFamily: theme.mono, fontSize: 11 };

  return {
    color: theme.series,
    grid: { left: 56, right: 20, top: 16, bottom: 28 },
    xAxis: {
      type: "category",
      data: monthly.map((row) => monthLabel(row.month)),
      axisLine: { lineStyle: { color: theme.grid } },
      axisLabel: { color: theme.textDim, fontFamily: theme.sans, fontSize: 11 },
    },
    yAxis: {
      type: "value",
      axisLabel: { ...axisLabel, formatter: (value: number) => money(value) },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text },
      formatter: (params: TooltipComponentFormatterCallbackParams) => {
        const rows = Array.isArray(params) ? params : [params];
        return rows
          .map((row) => {
            const index = typeof row.dataIndex === "number" ? row.dataIndex : 0;
            const partial = monthly[index]?.partial ?? false;
            const value = money(Number(row.value));
            return partial ? `${row.name}: ${value} (partial)` : `${row.name}: ${value}`;
          })
          .join("<br/>");
      },
    },
    series: [
      {
        name: "Net cost",
        type: "bar",
        data: monthly.map((row) => ({
          value: row.net,
          itemStyle: row.partial ? { opacity: 0.5 } : undefined,
        })),
        barWidth: "60%",
        itemStyle: { color: theme.series[0], borderRadius: 2 },
      },
    ],
  };
}
