/**
 * Assembles C1–C6 into the two layouts the host's own pane width picks
 * between (`charts/layout.ts`, `docs/design/COST-TRACKER-CHARTS.md` §5):
 *
 * - **Docked** (< `DOCKED_MAX_WIDTH`): C1 burn, then categories (C2).
 * - **Expanded**: C1 burn, then C2 and C3 side by side, then "From the
 *   bill" (C4–C6), which shows the `notEnabled`/`unavailable` note in place
 *   of those three charts until the billing export is on.
 *
 * A `ResizeObserver` on this component's own root measures the width — the
 * host decides how much room the app gets, not the window
 * (`docs/design/KAAVA-UX-SPEC.md` boards 06 and 11).
 */
import type { EChartsOption } from "echarts";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { burnOption } from "./charts/burn";
import { categoriesOption } from "./charts/categories";
import { dailyOption } from "./charts/daily";
import { estimateVsBilledOption, estimateVsBilledRows } from "./charts/estimateVsBilled";
import { layoutFor } from "./charts/layout";
import { monthlyOption } from "./charts/monthly";
import { onThemeChanged } from "./charts/onThemeChanged";
import { resourcesOption } from "./charts/resources";
import { readChartTheme, type ChartTheme } from "./charts/theme";
import { useChart } from "./charts/useChart";
import { money } from "./model";
import type { Estimate, Trends } from "./rpc";

/**
 * The root's own width, kept current across pane resizes. Starts at 0 — the
 * docked reading, the safe one before the first measurement lands.
 */
function useOwnWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return undefined;
    const target = ref.current;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(target);
    setWidth(target.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Re-read on `kaava:theme-changed` so a rebuilt option carries the new
 * colours — `useChart` itself only re-inits the canvas, not this
 * component's own option-building.
 */
function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState(readChartTheme);
  useEffect(() => onThemeChanged(() => setTheme(readChartTheme())), []);
  return theme;
}

function Chart({ option, label }: { option: EChartsOption; label: string }) {
  const ref = useChart(option);
  return <div ref={ref} className="costs__chart" role="img" aria-label={label} />;
}

/** `202609-05` -> `202609`. */
function invoiceMonthOf(isoDate: string): string {
  return isoDate.slice(0, 7).replace("-", "");
}

export function CostCharts({ estimate, trends }: { estimate: Estimate; trends: Trends | null }) {
  const [root, width] = useOwnWidth();
  const layout = layoutFor(width);
  const theme = useChartTheme();

  const thisMonth = invoiceMonthOf(estimate.monthStart);
  // `trends.daily` is already this invoice month only — the backend's own scope (`Trends`'s
  // doc comment in `rpc.ts`), so this reads it straight through rather than re-filtering it.
  const daily = trends?.state === "ok" ? trends.daily : null;

  const burn = useMemo(
    () =>
      burnOption(
        {
          toDate: estimate.toDate,
          forecast: estimate.forecast,
          budget: estimate.budget,
          monthStart: estimate.monthStart,
          now: estimate.now,
          monthEnd: estimate.monthEnd,
          daily,
        },
        theme,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `daily` is a fresh array each render; the fields actually read from `estimate` are the real dependency.
    [
      estimate.toDate,
      estimate.forecast,
      estimate.budget,
      estimate.monthStart,
      estimate.now,
      estimate.monthEnd,
      trends,
      theme,
    ],
  );

  const categories = useMemo(
    () => categoriesOption(estimate.categories, theme),
    [estimate.categories, theme],
  );
  const resources = useMemo(
    () => resourcesOption(estimate.categories, theme),
    [estimate.categories, theme],
  );

  const dailyChart = useMemo(() => (daily ? dailyOption(daily, theme) : null), [daily, theme]);

  const monthly = trends?.state === "ok" ? trends.monthly : null;
  const monthlyChart = useMemo(
    () => (monthly ? monthlyOption(monthly, theme) : null),
    [monthly, theme],
  );

  const billedServices = estimate.billed.state === "ok" ? estimate.billed.services : null;
  const estimateVsBilled = useMemo(
    () =>
      billedServices
        ? estimateVsBilledOption(estimateVsBilledRows(estimate.categories, billedServices), theme)
        : null,
    [estimate.categories, billedServices, theme],
  );

  return (
    <div className="costs__charts" ref={root}>
      <section className="costs__chart-section" aria-label="Spend this month">
        <Chart option={burn} label="Cumulative spend against the budget, this month" />
      </section>
      <section
        className={`costs__chart-row costs__chart-row--${layout}`}
        aria-label="Where the money goes"
      >
        <div className="costs__chart-pane">
          <Chart option={categories} label="Forecast by category" />
          <ul className="costs__legend" aria-hidden="true">
            {estimate.categories.map((c, i) => (
              <li key={c.id}>
                <span
                  className="costs__legend-swatch"
                  style={{ background: theme.series[i % theme.series.length] }}
                />
                <span className="costs__legend-label">{c.label}</span>
                <span className="costs__num">{money(c.forecast)}</span>
              </li>
            ))}
          </ul>
        </div>
        {layout === "expanded" && (
          <div className="costs__chart-pane">
            <Chart option={resources} label="Forecast by resource, top 8" />
          </div>
        )}
      </section>
      {layout === "expanded" && (
        <section className="costs__chart-section" aria-label="From the bill">
          <h2 className="costs__heading">From the bill</h2>
          {trends === null ? (
            <p className="app__note">Reading the billing export…</p>
          ) : trends.state === "notEnabled" ? (
            <p className="app__note">
              These charts need the Cloud Billing export to BigQuery. Enable the BigQuery API in
              this project, then in the Console open Billing → Billing export, and send the standard
              usage cost export to the <code>{trends.dataset}</code> dataset in this project.
            </p>
          ) : trends.state === "unavailable" ? (
            <p className="app__error">Could not read the billing export: {trends.message}</p>
          ) : (
            <div className="costs__chart-row costs__chart-row--expanded">
              {dailyChart && (
                <div className="costs__chart-pane">
                  <Chart option={dailyChart} label={`What ${thisMonth} cost, by day and service`} />
                </div>
              )}
              {monthlyChart && (
                <div className="costs__chart-pane">
                  <Chart option={monthlyChart} label="Net cost, the last six invoice months" />
                </div>
              )}
              {estimateVsBilled && (
                <div className="costs__chart-pane">
                  <Chart option={estimateVsBilled} label="Estimate beside billed, by service" />
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
