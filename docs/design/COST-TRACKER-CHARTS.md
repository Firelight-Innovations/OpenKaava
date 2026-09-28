# Cost Tracker charts (UI-7)

Status: **planned, not started.** It waits for the UI/UX rework. Build it against the reworked
layout and tokens, not the current ones. Owner: the Cloud UI workstream. Date: 2026-09-28.

The Cost Tracker page (`apps/costs/`) shows figures and tables today. This plan adds graphs,
drawn with Apache ECharts, from data the page already has plus two new BigQuery queries.

## 1. Decision: Apache ECharts, used directly

- **Library:** [`echarts`](https://echarts.apache.org) 6.x, Apache-2.0. Canvas renderer, a
  wide chart set, and one theme object for every colour and font.
- **No wrapper.** Do not add `echarts-for-react`. One small hook (§4.1) does init, update,
  resize and dispose. That is all a wrapper would give us, and it adds a dependency.
- **Tree-shaken imports only.** Import from `echarts/core` and register only the parts in use.
  Never `import * as echarts from "echarts"`, which bundles every chart type:

  ```ts
  import * as echarts from "echarts/core";
  import { BarChart, LineChart, PieChart } from "echarts/charts";
  import { DatasetComponent, GridComponent, LegendComponent, MarkLineComponent,
           TooltipComponent } from "echarts/components";
  import { CanvasRenderer } from "echarts/renderers";
  echarts.use([BarChart, LineChart, PieChart, DatasetComponent, GridComponent,
               LegendComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);
  ```

- **Where it goes:** a root `dependencies` entry, like every other runtime library here.
  Record the `costs` chunk size from `vite build` before and after, in the PR.

Alternatives looked at, and why not:

| Option | Why not |
|---|---|
| OpenCost UI, OptScale, Koku | Full platforms with their own backend. None embeds as a page. |
| Looker Studio (Google's billing dashboard) | Hosted by Google, cannot embed. Its SQL and chart choices are reused in §3. |
| Recharts | Lighter, but fewer chart types and SVG only. ECharts was chosen. |

## 2. The charts

"Now" means the chart draws from data the page has today. "Export" means it needs the
Cloud Billing export to BigQuery switched on (UI-4). Until then the page shows the
`notEnabled` note in that chart's place, not an empty frame.

| Id | Question it answers | Chart | Data | When |
|---|---|---|---|---|
| C1 | Will this month land under budget? | Line: cumulative spend to today (solid), forecast to month end (dashed), budget (horizontal `markLine`) | Estimate: `toDate`, `forecast`, `budget`, `monthStart`, `now`, `monthEnd`. Export: daily cumulative replaces the solid line | Now, better with export |
| C2 | Where does the money go? | Donut by category: Machines, Disks, Cloud Storage, Cloud Run, Addresses | Estimate `categories[].forecast` | Now |
| C3 | Which resources cost the most? | Horizontal bar, top 8 resources by forecast, rest as "Other" | Estimate `categories[].lines[]`, grouped by `resource` (`byResource` in `model.ts`) | Now |
| C4 | What did each day cost, by service? | Stacked bar, one bar per day, one stack per service | New `daily` query (§3) | Export |
| C5 | How does this month compare with earlier ones? | Bar, last 6 invoice months, net cost; this month partial and marked | New `monthly` query (§3) | Export |
| C6 | Is the estimate close to the bill? | Grouped bar per service: estimate beside billed | Estimate categories mapped to services (§3.3), and `billed.services` | Export |

Rules for every chart:

- Money uses `money()` from `model.ts`, in tooltips and axis labels. Keep one formatter.
- The estimate-only C1 has two real points (month start at 0, `now` at `toDate`). Draw it as
  exactly that. Do not make up a daily curve. The legend says "estimated".
- A chart with no data says why, in the page's own note style. It does not draw empty axes.
- Tooltips show the unit and the figure. Keep axis labels short.
- Charts follow the page poll. They update with `setOption`, and are not rebuilt.

## 3. Backend

### 3.1 New method: `costs/trends`

A separate method, not more fields on `Estimate`. The estimate polls every minute. The export
lags by hours, so trends poll every 10 minutes and only while the page is visible
(`useVisiblePoll`).

```ts
type Trends =
  | { state: "ok"; currency: string;
      daily: { day: string; service: string; net: number }[];   // this invoice month
      monthly: { month: string; net: number; partial: boolean }[]; // last 6, oldest first
      exportedAt: string | null }
  | { state: "notEnabled"; dataset: string }
  | { state: "unavailable"; message: string };
```

Rust side: `bigquery::trends(cloud, source, month_start) -> Result<Trends>` in
`src-tauri/src/cloud/bigquery.rs`, the same shape rules as `Billed`:

- Tag `#[serde(tag = "state", rename_all = "camelCase")]`, and a `#[serde(rename_all =
  "camelCase")]` on each struct variant. The tag rename does not reach the fields (see the
  `WakeSnapshot` fix in #139).
- A missing table, and a disabled BigQuery API, map to `NotEnabled` (`api_disabled`).
- A signed-out `gcloud` stays an `Err`. Anything else is `Unavailable`.

### 3.2 Queries

Both use `jobs.query` with named parameters, as `request()` does now. Never build SQL by
string from input. The dataset and table names come from `find_table` and are checked with
`is_identifier`.

```sql
-- daily: this invoice month, by day and service
SELECT DATE(usage_start_time) AS day, service.description AS service,
       SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS net
FROM `{project}.{dataset}.{table}`
WHERE invoice.month = @month AND project.id = @project
GROUP BY day, service ORDER BY day, service;

-- monthly: the last 6 invoice months
SELECT invoice.month AS month,
       SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS net
FROM `{project}.{dataset}.{table}`
WHERE invoice.month >= @first_month AND project.id = @project
GROUP BY month ORDER BY month;
```

Also add a time-partition filter to both queries (for example `_PARTITIONTIME >=` the first
day of the earliest month, less a few days for late rows). This keeps the bytes scanned small.
Check the real table's partitioning first. Put the bytes-processed figure from a test run in
the PR.

Fixtures: `src-tauri/fixtures/cloud/bigquery/daily.json` and `monthly.json`, in `jobs.query`
answer shape beside the existing `billing.json`. Build them by hand. Do not copy production
rows (no live GCP reads during development).

### 3.3 Category to service mapping (for C6)

One table in `model.ts`, tested:

| Estimate category | Billing export `service.description` |
|---|---|
| Machines, Disks, Addresses | Compute Engine |
| Cloud Storage | Cloud Storage |
| Cloud Run | Cloud Run |

A billed service with no estimate category shows as "not estimated", and its bar has the
billed value only. That is expected: the estimate does not model every service (see
`notEstimated`).

## 4. Frontend

```
apps/costs/ui/src/charts/
  useChart.ts        init on a ref, setOption on change, ResizeObserver -> resize, dispose
  theme.ts           reads CSS tokens into one ECharts theme object
  burn.ts            C1 option builder
  categories.ts      C2
  resources.ts       C3
  daily.ts           C4
  monthly.ts         C5
  estimateVsBilled.ts C6
  *.test.ts          one per builder
```

### 4.1 `useChart`

- `echarts.init(el, theme, { renderer: "canvas" })` once per element.
- `chart.setOption(option, { notMerge: true })` when the option changes.
- A `ResizeObserver` on the element calls `chart.resize()`. Panes resize all the time here.
  Window resize is not enough.
- `chart.dispose()` on unmount. An app is unmounted when its pane closes. A chart that is
  not disposed leaks its canvas and listeners.
- A hidden pane does not animate. Pass `animation: false` when
  `document.visibilityState === "hidden"`.

### 4.2 Theming: tokens, not literals

Canvas cannot read `var(--…)`. So `theme.ts` reads the tokens once with
`getComputedStyle(document.documentElement)` and builds the ECharts theme from them. After
the rework, a colour change is a token change in `src/tokens.css`. No chart file changes.

Tokens used today (all in `src/tokens.css`):

| Use | Token |
|---|---|
| Series colours, in order | `--accent`, `--graph-blue`, `--graph-teal`, `--graph-violet`, `--graph-pink`, `--warn` |
| Under / near / over budget | `--ok`, `--warn`, `--err` (same thresholds as `budgetTone`) |
| Axis labels, legend | `--text-dim`, font `--mono` for figures, `--sans` for names |
| Grid lines, axis lines | `--line` |
| Tooltip | background `--surface-2`, border `--line-2`, text `--text` |

**For the rework agent:** if the palette changes, keep six series colours as named tokens
(or rename them `--chart-1` … `--chart-6`), plus the three budget tones. `theme.ts` reads
only tokens. If the shell adds a light theme, it must tell apps that the theme changed, so
`useChart` can dispose the chart and init it again with the new theme.

### 4.3 Tests

- **Option builders are pure** (data in, ECharts option out). Test them in vitest with no
  DOM: series count, stack names, budget `markLine` value, "Other" bucketing, the two-point
  estimate-only C1, and empty input giving the "no data" case.
- **jsdom has no canvas.** In `App.test.tsx`, mock `echarts/core` (`vi.mock`), so `init`
  returns a stub. Check that the page asks for the right charts per `billed.state`, and that
  unmount calls `dispose`.
- Rust: `trends` against the fixtures. Add one test that `NotEnabled` is returned when there
  is no table and when the API is disabled. Add one test for the camelCase field names in
  the JSON.

## 5. Layout

The rework decides the layout. The plan gives the order of importance only:

1. C1 burn, beside or under the headline figures. It is the chart that answers the page's
   main question.
2. C2 and C3, side by side at wide widths and stacked when narrow.
3. C4 and C5, in their own "From the bill" section, which shows the `notEnabled` note until
   the export is on.
4. C6, next to the existing billed table.
5. The tables stay. Charts summarise, and tables give the exact figures.

## 6. Acceptance

- [ ] C1–C3 draw from the fixture (`KAAVA_CLOUD_FIXTURES`) and from live data in the agent
      instance (`pnpm ui launch`).
- [ ] C4–C6 draw from the fixtures, and show the `notEnabled` note on a project without the
      export.
- [ ] Colours come from tokens only (grep: no hex literals in `charts/`).
- [ ] A pane resize redraws the charts at the new size. Closing the pane disposes them.
- [ ] `costs` chunk size recorded before and after in the PR.
- [ ] Full `pnpm verify` passes. Tests as in §4.3.
- [ ] `apps/README.md` Cost Tracker entry mentions the charts and `costs/trends`.

## 7. Out of scope

- Budget alerts and notifications.
- Charts on any other page.
- Cost per Plane project or per agent session. That needs labels on resources first.
- Writing to BigQuery, or turning the export on from the app.
