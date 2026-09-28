import { describe, expect, it } from "vitest";
import type { BarSeriesOption } from "echarts";
import { estimateVsBilledOption, estimateVsBilledRows } from "./estimateVsBilled";
import { TEST_THEME } from "./testTheme";
import type { Category, ServiceCost } from "../rpc";

interface CategoryAxis {
  data?: unknown[];
}

const category = (id: Category["id"], forecast: number): Category => ({
  id,
  label: id,
  toDate: 0,
  forecast,
  lines: [],
});

const service = (name: string, net: number): ServiceCost => ({
  service: name,
  cost: net,
  credits: 0,
  net,
});

describe("estimateVsBilledRows", () => {
  it("folds machines, disks and addresses into Compute Engine", () => {
    const categories = [category("machines", 40), category("disks", 5), category("addresses", 1)];
    const rows = estimateVsBilledRows(categories, [service("Compute Engine", 44)]);
    expect(rows).toEqual([{ service: "Compute Engine", estimate: 46, billed: 44 }]);
  });

  it("marks a billed service the estimate does not model as not estimated", () => {
    const rows = estimateVsBilledRows([], [service("BigQuery", 3)]);
    expect(rows).toEqual([{ service: "BigQuery", estimate: 0, billed: 3 }]);
  });

  it("carries an estimated service through even before the export bills it", () => {
    const rows = estimateVsBilledRows([category("run", 12)], []);
    expect(rows).toEqual([{ service: "Cloud Run", estimate: 12, billed: 0 }]);
  });
});

describe("estimateVsBilledOption", () => {
  it("draws one estimate bar and one billed bar per service", () => {
    const rows = estimateVsBilledRows([category("storage", 8)], [service("Cloud Storage", 9)]);
    const option = estimateVsBilledOption(rows, TEST_THEME);
    expect((option.xAxis as CategoryAxis).data).toEqual(["Cloud Storage"]);
    const series = option.series as BarSeriesOption[];
    expect(series.map((s) => s.name)).toEqual(["Estimate", "Billed"]);
    expect(series[0].data).toEqual([8]);
    expect(series[1].data).toEqual([9]);
  });
});
