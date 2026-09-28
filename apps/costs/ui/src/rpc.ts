/**
 * Every call this app makes to its host, in one file.
 *
 * The shapes mirror `src-tauri/src/apps/costs.rs` and are restated rather than
 * imported, for the same reason as every other app's `rpc.ts`: an app knows
 * its host only through `@openkaava/bridge`.
 */
import { KaavaRpcError, invoke } from "@openkaava/bridge";

export interface Line {
  resource: string;
  detail: string;
  item: string;
  quantityToDate: number;
  quantityForecast: number;
  /** `vCPU·h`, `GiB·h`, `GPU·h`, `IP·h`, `GiB·mo`, `vCPU·s`, `GiB·s`. */
  unit: string;
  /** Per `unit`. `null` when no list price matched; both costs are then 0. */
  unitPrice: number | null;
  toDate: number;
  forecast: number;
  sku: string | null;
  note: string | null;
}

export interface Category {
  id: "machines" | "disks" | "storage" | "run" | "addresses";
  label: string;
  toDate: number;
  forecast: number;
  lines: Line[];
}

export interface Problem {
  part: string;
  message: string;
}

export interface ServiceCost {
  service: string;
  cost: number;
  /** Negative, as the export writes them. */
  credits: number;
  net: number;
}

/** What the BigQuery billing export says was charged, tagged by `state`. */
export type Billed =
  | {
      state: "ok";
      table: string;
      /** `202609`. */
      invoiceMonth: string;
      currency: string;
      cost: number;
      credits: number;
      net: number;
      exportedAt: string | null;
      services: ServiceCost[];
    }
  | { state: "notEnabled"; dataset: string }
  | { state: "unavailable"; message: string };

export interface Estimate {
  source: "live" | "fixture";
  project: string;
  currency: string;
  budget: number;
  now: string;
  monthStart: string;
  monthEnd: string;
  toDate: number;
  forecast: number;
  categories: Category[];
  problems: Problem[];
  notEstimated: string[];
  pricesAsOf: string | null;
  billed: Billed;
}

/** The backend's `cloud::Trouble`, tagged by `kind`. */
export type Trouble =
  | { kind: "gcloudMissing" }
  | { kind: "signedOut"; detail: string }
  | { kind: "denied"; detail: string }
  | { kind: "missing"; what: string }
  | { kind: "unreachable"; detail: string }
  | { kind: "api"; status: number; detail: string }
  | { kind: "fixture"; detail: string };

/** A cold first call downloads three price lists, one of them seven pages. */
const ESTIMATE_TIMEOUT_MS = 90_000;

export const estimate = (): Promise<Estimate> =>
  invoke<Estimate>("costs/estimate", undefined, ESTIMATE_TIMEOUT_MS);

/** The trouble an error carries, when the backend attached one. */
export function troubleOf(error: unknown): Trouble | null {
  if (!(error instanceof KaavaRpcError)) return null;
  const data = error.data as { kind?: unknown } | undefined;
  return data && typeof data.kind === "string" ? (data as Trouble) : null;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
