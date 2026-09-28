/**
 * Owns one ECharts instance's whole lifecycle: init on the returned ref,
 * `setOption` when `option` changes, resize when the element does, dispose on
 * unmount, and re-init when the shell's theme changes
 * (`docs/design/COST-TRACKER-CHARTS.md` §4.1, `@openkaava/bridge/theme`'s
 * `onThemeChanged`). No wrapper library — this is the whole of what one
 * would give us.
 *
 * Registers only the chart types, components and renderer the Cost Tracker
 * actually draws, from `echarts/core` rather than the bundled `echarts`
 * entry point, so the rest of the chart set never reaches the `costs` chunk.
 */
import type { EChartsOption } from "echarts";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import {
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from "echarts/components";
import { onThemeChanged } from "@openkaava/bridge/theme";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef, type RefObject } from "react";
import { readChartTheme } from "./theme";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  CanvasRenderer,
]);

/** A hidden pane does not animate; there is nobody watching the frames run. */
function apply(chart: echarts.ECharts, option: EChartsOption): void {
  chart.setOption(
    { ...option, animation: document.visibilityState !== "hidden" },
    { notMerge: true },
  );
}

export function useChart(option: EChartsOption): RefObject<HTMLDivElement | null> {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  // A ref mirror so the mount effect's `init` can always reach the option
  // current at the moment a theme change tears the instance down, without
  // making the option itself a dependency of that effect (see below).
  const latest = useRef(option);
  latest.current = option;

  useEffect(() => {
    if (!el.current) return undefined;
    const target = el.current;
    const init = (): void => {
      chart.current = echarts.init(target, readChartTheme(), { renderer: "canvas" });
      apply(chart.current, latest.current);
    };
    init();
    const observer = new ResizeObserver(() => chart.current?.resize());
    observer.observe(target);
    const offTheme = onThemeChanged(() => {
      chart.current?.dispose();
      init();
    });
    return () => {
      observer.disconnect();
      offTheme();
      chart.current?.dispose();
      chart.current = null;
    };
    // Deliberately mount/unmount only: an `option` change is applied by the
    // effect below through `setOption`, not by rebuilding the instance. It
    // reads `latest.current` rather than `option` itself, so this has no
    // dependency to list.
  }, []);

  useEffect(() => {
    if (chart.current) apply(chart.current, option);
  }, [option]);

  return el;
}
