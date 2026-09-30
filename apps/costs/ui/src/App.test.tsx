// @vitest-environment jsdom
/**
 * The page rendered against a stubbed bridge: what an estimate draws, what an
 * unpriced line and a failed part look like, and what a signed-out answer
 * draws instead. `pnpm dev:agent` has no backend, so this is where the wiring
 * between the call and the page is checked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { Estimate, Trends } from "./rpc";

// jsdom implements no `ResizeObserver` — see `apps/schematify/ui/src/App.landing.test.tsx`
// for the same stub. `CostCharts` uses one to measure its own pane width.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopResizeObserver);

// jsdom lays out nothing, so every element's own rect is all zeros, which
// would pin `CostCharts` to the docked reading in every test. Stand the pane
// at a width past `DOCKED_MAX_WIDTH`, the expanded desktop case this file
// otherwise exercises throughout.
vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
  width: 900,
  height: 600,
  top: 0,
  left: 0,
  right: 900,
  bottom: 600,
  x: 0,
  y: 0,
  toJSON: () => ({}),
});

// jsdom has no canvas, so `echarts/core` is mocked throughout — this file
// checks that the page asks for the right charts, not what ECharts draws
// with them (`docs/design/COST-TRACKER-CHARTS.md` §4.3).
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

const bridge = vi.hoisted(() => {
  class KaavaRpcError extends Error {
    constructor(
      readonly code: number,
      message: string,
      readonly data?: unknown,
    ) {
      super(message);
    }
  }
  return { invoke: vi.fn(), KaavaRpcError };
});

vi.mock("@openkaava/bridge", () => ({
  invoke: bridge.invoke,
  KaavaRpcError: bridge.KaavaRpcError,
  reportPainted: vi.fn(),
  // `@openkaava/bridge/theme` (`useChart` and `CostCharts`' own theme
  // re-read) compiles to a relative import of this same module's `on` —
  // a no-op subscription is enough; the theme-change re-init itself is
  // `useChart.test.ts`'s own unit test, not this page-level one.
  on: vi.fn(() => () => {}),
}));

import App from "./App";

const trendsNotEnabled: Trends = { state: "notEnabled", dataset: "billing_export" };

/** Routes `costs/estimate` and `costs/trends` to their own answers, as the real bridge would. */
function mockRpc(estimateValue: Estimate, trendsValue: Trends = trendsNotEnabled): void {
  bridge.invoke.mockImplementation((method: unknown) =>
    method === "costs/trends" ? Promise.resolve(trendsValue) : Promise.resolve(estimateValue),
  );
}

const estimate: Estimate = {
  source: "fixture",
  project: "fixture",
  currency: "USD",
  budget: 150,
  now: "2026-09-28T21:00:00Z",
  monthStart: "2026-09-01T00:00:00Z",
  monthEnd: "2026-10-01T00:00:00Z",
  toDate: 30.94,
  forecast: 33.22,
  categories: [
    {
      id: "machines",
      label: "Machines",
      toDate: 30.94,
      forecast: 33.22,
      lines: [
        {
          resource: "kaava-worker",
          detail: "e2-standard-8 · us-central1-a · running",
          item: "vCPU",
          quantityToDate: 960,
          quantityForecast: 1032.5,
          unit: "vCPU·h",
          unitPrice: 0.02181159,
          toDate: 20.94,
          forecast: 22.52,
          sku: "E2 Instance Core running in Americas (CF4E-A0C7-E3BF)",
          note: null,
        },
        {
          resource: "kaava-worker",
          detail: "e2-standard-8 · us-central1-a · running",
          item: "Memory",
          quantityToDate: 3840,
          quantityForecast: 4130,
          unit: "GiB·h",
          unitPrice: 0.00292353,
          toDate: 10,
          forecast: 10.7,
          sku: "E2 Instance Ram running in Americas (F449-33EC-A5EF)",
          note: null,
        },
      ],
    },
    {
      id: "storage",
      label: "Cloud Storage",
      toDate: 0,
      forecast: 0,
      lines: [
        {
          resource: "veistra-prod-archive",
          detail: "coldline · us · 120.0 GiB now",
          item: "Stored data",
          quantityToDate: 35.5,
          quantityForecast: 39.5,
          unit: "GiB·mo",
          unitPrice: null,
          toDate: 0,
          forecast: 0,
          sku: null,
          note: "No list price matched; left out of the totals.",
        },
      ],
    },
  ],
  problems: [{ part: "Cloud Run usage", message: "Google Cloud refused the request: no access" }],
  notEstimated: ["Network egress and Cloud NAT."],
  pricesAsOf: "2026-09-27T07:00:00Z",
  billed: {
    state: "ok",
    table: "gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9",
    invoiceMonth: "202609",
    currency: "USD",
    cost: 30.03,
    credits: -0.78,
    net: 29.25,
    exportedAt: "2026-09-28T13:00:00Z",
    services: [
      { service: "Compute Engine", cost: 28.12, credits: -0.78, net: 27.34 },
      { service: "Cloud Storage", cost: 1.91, credits: 0, net: 1.91 },
    ],
  },
};

afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
  echarts.init.mockClear();
});

describe("Cost Tracker", () => {
  it("draws the month, the forecast against the budget, and each resource", async () => {
    mockRpc(estimate);
    render(<App />);

    expect(await screen.findByText("Estimated so far in September")).toBeTruthy();
    expect(screen.getByText("$30.94", { selector: ".costs__big" })).toBeTruthy();
    expect(screen.getByText("$33.22", { selector: ".costs__big" }).className).toContain(
      "costs__big--ok",
    );
    expect(screen.getByText(/\$116\.78 under the \$150\.00 budget/)).toBeTruthy();
    expect(screen.getByText(/Day 28 of 30/)).toBeTruthy();
    expect(bridge.invoke).toHaveBeenCalledWith("costs/estimate", undefined, 90_000);

    const machines = screen.getByRole("region", { name: "Machines" });
    expect(within(machines).getAllByText("kaava-worker")).toHaveLength(1);
    expect(within(machines).getByText("$0.0218 / vCPU·h")).toBeTruthy();
    expect(within(machines).getByText("960 vCPU·h")).toBeTruthy();
  });

  it("shows an unpriced line and a failed part rather than hiding them", async () => {
    mockRpc(estimate);
    render(<App />);

    const storage = await screen.findByRole("region", { name: "Cloud Storage" });
    expect(within(storage).getByText(/No list price matched/)).toBeTruthy();
    expect(screen.getByText(/Cloud Run usage: Google Cloud refused/)).toBeTruthy();
    expect(screen.getByText("Network egress and Cloud NAT.")).toBeTruthy();
  });

  it("turns the forecast red once it passes the budget", async () => {
    mockRpc({ ...estimate, forecast: 162.5 });
    render(<App />);

    const forecast = await screen.findByText("$162.50", { selector: ".costs__big" });
    expect(forecast.className).toContain("costs__big--err");
    expect(screen.getByText(/\$12\.50 over the \$150\.00 budget/)).toBeTruthy();
  });

  it("puts the billed figure beside the estimate, with a row per service", async () => {
    mockRpc(estimate);
    render(<App />);

    expect(await screen.findByText("Billed so far")).toBeTruthy();
    expect(screen.getByText("$29.25", { selector: ".costs__big" })).toBeTruthy();
    expect(screen.getByText(/exported through Sep 28, 1:00 PM UTC\)/)).toBeTruthy();
    const billed = screen.getByRole("region", { name: "Billed by service" });
    expect(within(billed).getByText("Compute Engine")).toBeTruthy();
    expect(within(billed).getByText("−$0.78")).toBeTruthy();
    expect(within(billed).getByText("$27.34")).toBeTruthy();
  });

  it("says how to turn the export on when it is not enabled", async () => {
    mockRpc({ ...estimate, billed: { state: "notEnabled", dataset: "billing_export" } });
    render(<App />);

    expect(await screen.findByText(/Billed cost appears once/)).toBeTruthy();
    expect(screen.getByText("billing_export")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Billed by service" })).toBeNull();
    expect(screen.getByText("Billed so far").nextElementSibling?.textContent).toBe("—");
  });

  it("keeps the estimate when the export cannot be read", async () => {
    mockRpc({
      ...estimate,
      billed: { state: "unavailable", message: "Google Cloud refused the request: no bigquery" },
    });
    render(<App />);

    expect(await screen.findByText(/Could not read the billing export/)).toBeTruthy();
    expect(screen.getByText("$30.94", { selector: ".costs__big" })).toBeTruthy();
  });

  it("draws the fix when gcloud is signed out", async () => {
    bridge.invoke.mockRejectedValue(
      new bridge.KaavaRpcError(-32603, "gcloud is not signed in", {
        kind: "signedOut",
        detail: "no account",
      }),
    );
    render(<App />);

    expect(await screen.findByText("Signed out of Google Cloud")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("says the export is needed for the daily and monthly charts until trends says otherwise", async () => {
    mockRpc(estimate);
    render(<App />);

    expect(await screen.findByText("From the bill")).toBeTruthy();
    expect(
      screen.getAllByText(/The Cloud Billing export to BigQuery is off/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("What did each day cost, by service?")).toBeTruthy();
    expect(screen.queryByLabelText(/What 202609 cost, by day and service/)).toBeNull();
  });

  it("draws the day-by-day and month-by-month charts once trends answers ok", async () => {
    mockRpc(estimate, {
      state: "ok",
      currency: "USD",
      daily: [{ day: "2026-09-01", service: "Compute Engine", net: 10 }],
      monthly: [{ month: "202609", net: 10, partial: true }],
      exportedAt: "2026-09-28T13:00:00Z",
    });
    render(<App />);

    expect(await screen.findByLabelText(/What 202609 cost, by day and service/)).toBeTruthy();
    expect(screen.getByLabelText("Net cost, the last six invoice months")).toBeTruthy();
    expect(bridge.invoke).toHaveBeenCalledWith("costs/trends", undefined, 30_000);
  });

  it("initialises a chart per pane and disposes every one of them on unmount", async () => {
    mockRpc(estimate);
    const { unmount } = render(<App />);
    await screen.findByText("Estimated so far in September");

    // The headline text can paint a tick before the panes mount their charts,
    // so wait for them rather than sampling once (this was flaky in CI).
    await waitFor(() => expect(echarts.init.mock.results.length).toBeGreaterThan(0));
    const charts = echarts.init.mock.results.map((r) => r.value as { dispose: () => void });

    unmount();

    for (const chart of charts) expect(chart.dispose).toHaveBeenCalledTimes(1);
  });

  it("puts the headline figures in the same hero as C1, so the layout can place them beside it", async () => {
    mockRpc(estimate);
    const { container } = render(<App />);
    await screen.findByText("Estimated so far in September");

    const hero = container.querySelector(".costs__hero");
    expect(hero).not.toBeNull();
    expect(hero?.querySelector(".costs__summary")).not.toBeNull();
    expect(hero?.querySelector(".costs__hero-chart")).not.toBeNull();
    // The mount effect measures the stubbed 900px pane and re-renders expanded.
    // Asserting "not expanded" here raced that re-render (flaky in CI), so wait
    // for the measured state instead.
    await waitFor(() => expect(hero?.className).toContain("costs__hero--expanded"));
  });

  it("waits with a note while the first read is pending, with no error yet", async () => {
    bridge.invoke.mockImplementation(() => new Promise(() => {}));
    render(<App />);
    expect(await screen.findByText(/Reading the project and the price lists/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("ends the wait in a timed-out state with Retry when the bridge gives up", async () => {
    bridge.invoke.mockImplementation(() =>
      Promise.reject(new bridge.KaavaRpcError(-32001, "request timed out")),
    );
    render(<App />);
    expect(await screen.findByText("Reading Cost timed out")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("says which account to check when Google Cloud denies the read", async () => {
    bridge.invoke.mockImplementation(() =>
      Promise.reject(new bridge.KaavaRpcError(-32603, "refused", { kind: "denied", detail: "no" })),
    );
    render(<App />);
    expect(await screen.findByText("This Google account may not read that")).toBeTruthy();
    expect(screen.getByText("gcloud auth list")).toBeTruthy();
  });

  it("tells you to install the CLI when gcloud is missing", async () => {
    bridge.invoke.mockImplementation(() =>
      Promise.reject(new bridge.KaavaRpcError(-32603, "no gcloud", { kind: "gcloudMissing" })),
    );
    render(<App />);
    expect(await screen.findByText("The Google Cloud CLI is not installed")).toBeTruthy();
  });
});
