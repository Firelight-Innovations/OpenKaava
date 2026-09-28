import { describe, expect, it } from "vitest";
import { budgetTone, byResource, dayOf, money, quantity, unitPrice, verdict } from "./model";
import type { Estimate, Line } from "./rpc";

const line = (resource: string, item: string, toDate: number, forecast: number): Line => ({
  resource,
  detail: `${resource} detail`,
  item,
  quantityToDate: 1,
  quantityForecast: 1,
  unit: "vCPU·h",
  unitPrice: 0.02,
  toDate,
  forecast,
  sku: null,
  note: null,
});

const estimate = (forecast: number, budget = 150): Estimate => ({
  source: "fixture",
  project: "fixture",
  currency: "USD",
  budget,
  now: "2026-09-28T21:00:00Z",
  monthStart: "2026-09-01T00:00:00Z",
  monthEnd: "2026-10-01T00:00:00Z",
  toDate: forecast * 0.9,
  forecast,
  categories: [],
  problems: [],
  notEstimated: [],
  pricesAsOf: null,
});

describe("budgetTone", () => {
  it("is ok under 80 %, warn up to the budget, err past it", () => {
    expect(budgetTone(100, 150)).toBe("ok");
    expect(budgetTone(120.01, 150)).toBe("warn");
    expect(budgetTone(150, 150)).toBe("warn");
    expect(budgetTone(150.01, 150)).toBe("err");
  });
});

describe("formatting", () => {
  it("shows money to the cent, and a sliver as under a cent", () => {
    expect(money(0)).toBe("$0.00");
    expect(money(0.001)).toBe("<$0.01");
    expect(money(1234.5)).toBe("$1,234.50");
  });

  it("keeps a unit price's small digits and names free tiers", () => {
    expect(unitPrice(0.02181159, "vCPU·h")).toBe("$0.0218 / vCPU·h");
    expect(unitPrice(0.000024, "vCPU·s")).toBe("$0.000024 / vCPU·s");
    expect(unitPrice(0.1, "GiB·mo")).toBe("$0.1 / GiB·mo");
    expect(unitPrice(0, "IP·h")).toBe("free / IP·h");
    expect(unitPrice(null, "IP·h")).toBe("—");
  });

  it("rounds big quantities harder than small ones", () => {
    expect(quantity(66780, "vCPU·s")).toBe("66,780 vCPU·s");
    expect(quantity(3.8123, "GiB·mo")).toBe("3.81 GiB·mo");
  });
});

describe("byResource", () => {
  it("groups in first-seen order and totals each group", () => {
    const groups = byResource([
      line("b", "vCPU", 1, 2),
      line("a", "vCPU", 3, 4),
      line("b", "Memory", 0.5, 1),
    ]);
    expect(groups.map((g) => g.resource)).toEqual(["b", "a"]);
    expect(groups[0].toDate).toBe(1.5);
    expect(groups[0].forecast).toBe(3);
    expect(groups[0].lines.map((l) => l.item)).toEqual(["vCPU", "Memory"]);
  });
});

describe("the month", () => {
  it("counts the day in UTC", () => {
    expect(dayOf(estimate(90))).toEqual({ day: 28, days: 30 });
  });

  it("says how far under or over the budget the forecast is", () => {
    expect(verdict(estimate(92.82))).toBe("$57.18 under the $150.00 budget");
    expect(verdict(estimate(160))).toBe("$10.00 over the $150.00 budget");
  });
});
