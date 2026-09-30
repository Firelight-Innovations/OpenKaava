/**
 * Assembles C1–C6 into the two layouts the host's own pane width picks
 * between (`charts/layout.ts`, `docs/design/COST-TRACKER-CHARTS.md` §5,
 * `docs/design/KAAVA-UX-SPEC.md` boards 06 and 11):
 *
 * - **Docked** (< `DOCKED_MAX_WIDTH`): C1 as a mini sparkline, then forecast
 *   by category as compact bar rows — a donut has no room to be read at rail
 *   width.
 * - **Expanded**: C1 in full, then C2 and C3 side by side, then "From the
 *   bill" (C4–C6), which shows one placeholder card per chart in place of
 *   the real thing until the billing export is on.
 *
 * A `ResizeObserver` on this component's own root measures the width — the
 * host decides how much room the app gets, not the window.
 */
import { onThemeChanged } from "@openkaava/bridge/theme";
import type { EChartsOption } from "echarts";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { burnOption } from "./charts/burn";
import { categoriesOption } from "./charts/categories";
import { dailyOption } from "./charts/daily";
import { estimateVsBilledOption, estimateVsBilledRows } from "./charts/estimateVsBilled";
import { layoutFor } from "./charts/layout";
import { monthlyOption } from "./charts/monthly";
import { resourcesOption } from "./charts/resources";
import { readChartTheme, type ChartTheme } from "./charts/theme";
import { useChart } from "./charts/useChart";
import { money } from "./model";
import type { Category, Estimate, Trends } from "./rpc";

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

/** Every chart's own visible heading: the question it answers, plus its C1–C6 id. */
function ChartHead({ id, title }: { id: string; title: string }) {
  return (
    <div className="costs__chart-head">
      <span className="costs__chart-title">{title}</span>
      <span className="costs__chart-id">{id}</span>
    </div>
  );
}

function Chart({
  option,
  label,
  compact,
}: {
  option: EChartsOption;
  label: string;
  compact?: boolean;
}) {
  const ref = useChart(option);
  const className = compact ? "costs__chart costs__chart--sparkline" : "costs__chart";
  return <div ref={ref} className={className} role="img" aria-label={label} />;
}

/** C2's own legend: swatch, name, `$`, and `%` of the forecast total — the exact
 *  figures the donut itself doesn't label (`categories.ts`'s doc comment). */
function CategoryLegend({ categories, theme }: { categories: Category[]; theme: ChartTheme }) {
  const total = categories.reduce((sum, c) => sum + c.forecast, 0);
  return (
    <ul className="costs__legend" aria-hidden="true">
      {categories.map((c, i) => (
        <li key={c.id}>
          <span
            className="costs__legend-swatch"
            style={{ background: theme.series[i % theme.series.length] }}
          />
          <span className="costs__legend-label">{c.label}</span>
          <span className="costs__num">{money(c.forecast)}</span>
          <span className="costs__legend-pct">
            {total > 0 ? `${Math.round((c.forecast / total) * 100)}%` : "—"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The docked reading's compact swap for C2's donut (board 11): a bar per
 *  category, scaled to the largest one — a ring has no room to be read at
 *  rail width. */
function CategoryBars({ categories, theme }: { categories: Category[]; theme: ChartTheme }) {
  const max = Math.max(1, ...categories.map((c) => c.forecast));
  return (
    <ul className="costs__catbars" aria-label="Forecast by category">
      {categories.map((c, i) => {
        const color = theme.series[i % theme.series.length];
        return (
          <li key={c.id}>
            <span className="costs__legend-swatch" style={{ background: color }} />
            <span className="costs__catbars-name">{c.label}</span>
            <span className="costs__catbars-track">
              <span
                className="costs__catbars-fill"
                style={{ width: `${(c.forecast / max) * 100}%`, background: color }}
              />
            </span>
            <span className="costs__num">{money(c.forecast)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** `202609-05` -> `202609`. */
function invoiceMonthOf(isoDate: string): string {
  return isoDate.slice(0, 7).replace("-", "");
}

/** One of "FROM THE BILL"'s three placeholder cards (board 06), shown in
 *  place of C4–C6 until the billing export is on — the board's own copy,
 *  with the real project name in place of its example project. */
function BillPlaceholder({
  id,
  question,
  project,
}: {
  id: string;
  question: string;
  project: string;
}) {
  return (
    <div className="costs__chart-pane costs__chart-pane--placeholder">
      <ChartHead id={id} title={question} />
      <p className="app__note costs__chart-placeholder-note">
        The Cloud Billing export to BigQuery is off, so this chart has no data yet. Turn it on in
        the Google Cloud console for {project}. Data appears a few hours later.
      </p>
    </div>
  );
}

export function CostCharts({
  estimate,
  trends,
  summary,
}: {
  estimate: Estimate;
  trends: Trends | null;
  /** The headline figures. They sit beside C1 when expanded and above it when docked. */
  summary?: ReactNode;
}) {
  const [root, width] = useOwnWidth();
  const layout = layoutFor(width);
  const theme = useChartTheme();
  const docked = layout === "docked";

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
        { compact: docked },
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
      docked,
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
      <div className={docked ? "costs__hero" : "costs__hero costs__hero--expanded"}>
        {summary}
        <section className="costs__chart-section costs__hero-chart" aria-label="Spend this month">
          {!docked && <ChartHead id="C1" title="Will this month land under budget?" />}
          <Chart
            option={burn}
            label="Cumulative spend against the budget, this month"
            compact={docked}
          />
          {!docked && !daily?.length && (
            <p className="costs__chart-caption">
              Two real points from the estimate. It becomes a daily line when the billing export is
              on.
            </p>
          )}
        </section>
      </div>
      {docked ? (
        <section className="costs__chart-section" aria-label="Where the money goes">
          <span className="costs__chart-label">By category · forecast</span>
          <CategoryBars categories={estimate.categories} theme={theme} />
        </section>
      ) : (
        <section
          className="costs__chart-row costs__chart-row--expanded"
          aria-label="Where the money goes"
        >
          <div className="costs__chart-pane">
            <ChartHead id="C2" title="Where does the money go?" />
            <Chart option={categories} label="Forecast by category" />
            <CategoryLegend categories={estimate.categories} theme={theme} />
          </div>
          <div className="costs__chart-pane">
            <ChartHead id="C3" title="Which resources cost the most?" />
            <Chart option={resources} label="Forecast by resource, top 8" />
          </div>
        </section>
      )}
      {docked && trends !== null && trends.state !== "ok" && (
        <p className="app__note costs__chart-placeholder-note costs__chart-placeholder-note--docked">
          Daily and monthly charts need the Cloud Billing export to BigQuery. Expand the page to see
          what is waiting on it.
        </p>
      )}
      {!docked && (
        <section className="costs__chart-section" aria-label="From the bill">
          <div className="costs__chart-section-head">
            <h2 className="costs__chart-label">From the bill</h2>
            <span className="costs__chart-caption">
              C4 daily by service · C5 last 6 months · C6 estimate vs billed
            </span>
          </div>
          {trends === null ? (
            <p className="app__note">Reading the billing export…</p>
          ) : trends.state === "notEnabled" ? (
            <div className="costs__chart-row costs__chart-row--expanded">
              <BillPlaceholder
                id="C4"
                question="What did each day cost, by service?"
                project={estimate.project}
              />
              <BillPlaceholder
                id="C5"
                question="How does this month compare?"
                project={estimate.project}
              />
              <BillPlaceholder
                id="C6"
                question="Is the estimate close to the bill?"
                project={estimate.project}
              />
            </div>
          ) : trends.state === "unavailable" ? (
            <p className="app__error">Could not read the billing export: {trends.message}</p>
          ) : (
            <div className="costs__chart-row costs__chart-row--expanded">
              {dailyChart && (
                <div className="costs__chart-pane">
                  <ChartHead id="C4" title="What did each day cost, by service?" />
                  <Chart option={dailyChart} label={`What ${thisMonth} cost, by day and service`} />
                </div>
              )}
              {monthlyChart && (
                <div className="costs__chart-pane">
                  <ChartHead id="C5" title="How does this month compare?" />
                  <Chart option={monthlyChart} label="Net cost, the last six invoice months" />
                </div>
              )}
              {estimateVsBilled && (
                <div className="costs__chart-pane">
                  <ChartHead id="C6" title="Is the estimate close to the bill?" />
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
