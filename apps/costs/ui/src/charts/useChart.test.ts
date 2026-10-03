// @vitest-environment jsdom
/**
 * `useChart`'s own lifecycle, isolated from any real chart option: init on
 * mount, `setOption` again when the option changes, dispose on unmount, and
 * dispose-then-reinit on a theme change (`docs/design/COST-TRACKER-CHARTS.md`
 * §4.3). `echarts/core` is mocked throughout — jsdom has no canvas, and this
 * hook's own wiring is what is under test, not ECharts itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EChartsOption } from "echarts";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";

// jsdom implements no `ResizeObserver` — see `App.landing.test.tsx` for the
// same stub and why a no-op is the honest shape in a test with no real
// layout to observe.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopResizeObserver);

const echarts = vi.hoisted(() => ({
  init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })),
  use: vi.fn(),
}));
vi.mock("echarts/core", () => echarts);
vi.mock("echarts/charts", () => ({ BarChart: {}, LineChart: {}, PieChart: {} }));
vi.mock("echarts/components", () => ({
  DatasetComponent: {},
  GridComponent: {},
  LegendComponent: {},
  MarkLineComponent: {},
  TooltipComponent: {},
}));
vi.mock("echarts/renderers", () => ({ CanvasRenderer: {} }));

// `useChart` re-inits on the shell's real theme broadcast now
// (`@openkaava/bridge/theme`'s `onThemeChanged`), not a raw `message` event —
// this stands in for the bridge so a test can fire that change itself,
// without a real bridge client or transport.
const theme = vi.hoisted(() => {
  let cb: (() => void) | undefined;
  return {
    change: () => cb?.(),
    onThemeChanged: vi.fn((c?: () => void) => {
      cb = c;
      return () => {
        cb = undefined;
      };
    }),
  };
});
vi.mock("@openkaava/bridge/theme", () => ({ onThemeChanged: theme.onThemeChanged }));

import { useChart } from "./useChart";

function TestChart({ option }: { option: EChartsOption }) {
  const ref = useChart(option);
  return createElement("div", { ref });
}

function lastChart(): { setOption: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } {
  const results = echarts.init.mock.results;
  return results[results.length - 1]?.value as ReturnType<typeof echarts.init>;
}

afterEach(() => {
  cleanup();
  echarts.init.mockClear();
});

describe("useChart", () => {
  it("initialises one chart on mount and applies the given option", () => {
    render(createElement(TestChart, { option: { series: [] } }));
    expect(echarts.init).toHaveBeenCalledTimes(1);
    // Applied twice on mount: once by `init` itself, once more by the
    // option-update effect, which also runs on the first render.
    expect(lastChart().setOption).toHaveBeenCalledTimes(2);
  });

  it("initialises with no ECharts theme, so the page's own palette is never read as component options", () => {
    render(createElement(TestChart, { option: { series: [] } }));
    // A `ChartTheme` has a string `grid`; ECharts reads a theme's `grid` as the
    // grid component and throws, which blanked the whole Cost Tracker page.
    expect((echarts.init.mock.calls[0] as unknown[] | undefined)?.[1]).toBeUndefined();
  });

  it("calls setOption again, without re-initialising, when the option changes", () => {
    const { rerender } = render(createElement(TestChart, { option: { series: [] } }));
    rerender(createElement(TestChart, { option: { series: [{ type: "bar" }] } }));
    expect(echarts.init).toHaveBeenCalledTimes(1);
    expect(lastChart().setOption).toHaveBeenCalledTimes(3);
  });

  it("disposes the chart on unmount", () => {
    const { unmount } = render(createElement(TestChart, { option: { series: [] } }));
    const chart = lastChart();
    unmount();
    expect(chart.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes and re-initialises when the shell's theme changes", () => {
    render(createElement(TestChart, { option: { series: [] } }));
    const first = lastChart();
    theme.change();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(echarts.init).toHaveBeenCalledTimes(2);
    expect(lastChart().setOption).toHaveBeenCalledTimes(1);
  });
});
