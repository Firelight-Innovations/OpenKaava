import { reportPainted } from "@openkaava/bridge";
import { useCallback, useEffect, useState } from "react";
import { TroubleNote } from "../../../shared/trouble";
import { CostCharts } from "./CostCharts";
import {
  budgetTone,
  byResource,
  dayOf,
  exportedLabel,
  money,
  monthName,
  quantity,
  unitPrice,
  verdict,
} from "./model";
import * as rpc from "./rpc";
import type { Billed, Category, Estimate, Trends } from "./rpc";
import { useVisiblePoll } from "./useVisiblePoll";

/**
 * Usage moves by the hour and prices by the day, so a minute is plenty. Each
 * refresh is a round of inventory and Monitoring reads; the price lists are
 * cached by the backend for a day.
 */
const POLL_MS = 60_000;

/** The billing export lags by hours, so trends poll far less often than the estimate (§3.1). */
const TRENDS_POLL_MS = 600_000;

export default function App() {
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [trends, setTrends] = useState<Trends | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setEstimate(await rpc.estimate());
      setFailure(null);
      setUpdated(new Date());
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  }, []);
  useVisiblePoll(refresh, POLL_MS);

  const refreshTrends = useCallback(async () => {
    try {
      setTrends(await rpc.trends());
    } catch {
      // The charts that need this stay in their "reading" state; the page's
      // own failure handling is `refresh`'s, not this one's.
    }
  }, []);
  useVisiblePoll(refreshTrends, TRENDS_POLL_MS);

  useEffect(() => {
    if (estimate || failure) reportPainted();
  }, [estimate, failure]);

  const blocking = !estimate && failure !== null;

  return (
    <div className="app">
      <header className="app__head">
        <h1 className="app__title app__title--hidden">Cost Tracker</h1>
        {estimate && (
          <span className="app__sub">
            Google Cloud · {estimate.project}
            {estimate.source === "fixture" && <span className="costs__badge">fixture</span>}
          </span>
        )}
        <span className="app__host">
          {updated
            ? `updated ${updated.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
            : blocking
              ? "not connected"
              : "reading…"}
        </span>
        <button
          type="button"
          className="app__up costs__refresh"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      <div className="app__body">
        {blocking ? (
          <Blocked failure={failure} onRetry={() => void refresh()} />
        ) : !estimate ? (
          <p className="app__note">
            Reading the project and the price lists. The first read of the day downloads Google's
            price sheet and can take a minute.
          </p>
        ) : (
          <div className="costs__page">
            {failure !== null && (
              <p className="app__error">
                Last refresh failed: {rpc.messageOf(failure)}. Showing the previous estimate.
              </p>
            )}
            <CostCharts
              estimate={estimate}
              trends={trends}
              summary={<Summary estimate={estimate} />}
            />
            {estimate.problems.length > 0 && (
              <section className="costs__problems" aria-label="Parts that could not be read">
                {estimate.problems.map((p) => (
                  <p key={p.part} className="app__error">
                    {p.part}: {p.message}
                  </p>
                ))}
              </section>
            )}
            {estimate.billed.state === "ok" && estimate.billed.services.length > 0 && (
              <BilledTable billed={estimate.billed} />
            )}
            {estimate.categories.map((c) => (
              <CategoryTable key={c.id} category={c} />
            ))}
            <Caveats estimate={estimate} />
          </div>
        )}
      </div>
    </div>
  );
}

/** The month so far, the forecast, and the budget bar. */
function Summary({ estimate }: { estimate: Estimate }) {
  const tone = budgetTone(estimate.forecast, estimate.budget);
  const { day, days } = dayOf(estimate);
  const month = monthName(estimate);
  // The bar's scale reaches past both the budget and the forecast, so the
  // marker and the forecast's end are never drawn off the edge.
  const scale = Math.max(estimate.budget, estimate.forecast) * 1.1 || 1;
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100).toFixed(2)}%`;
  return (
    <section className="costs__summary" aria-label="This month">
      <div className="costs__figures">
        <Figure label={`Estimated so far in ${month}`} value={money(estimate.toDate)} />
        <Figure
          label="Billed so far"
          value={estimate.billed.state === "ok" ? money(estimate.billed.net) : "—"}
        />
        <Figure label={`Forecast for ${month}`} value={money(estimate.forecast)} tone={tone} />
        <Figure label="Budget" value={money(estimate.budget)} />
      </div>
      <BilledNote billed={estimate.billed} />
      <div
        className="costs__bar"
        role="img"
        aria-label={`${money(estimate.toDate)} so far, ${money(estimate.forecast)} forecast, against a ${money(estimate.budget)} budget`}
      >
        <span
          className={`costs__bar-forecast costs__bar-forecast--${tone}`}
          style={{ width: pct(estimate.forecast) }}
        />
        <span
          className={`costs__bar-spent costs__bar-spent--${tone}`}
          style={{ width: pct(estimate.toDate) }}
        />
        <span className="costs__bar-budget" style={{ left: pct(estimate.budget) }} />
      </div>
      <p className={`costs__verdict costs__verdict--${tone}`}>
        Forecast {verdict(estimate)}. Day {day} of {days}
        {estimate.pricesAsOf && (
          <>
            {" "}
            · list prices as of{" "}
            {new Date(estimate.pricesAsOf).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            })}
          </>
        )}
        .
      </p>
      <ul className="costs__split" aria-label="Forecast by category">
        {estimate.categories.map((c) => (
          <li key={c.id}>
            <span className="costs__split-label">{c.label}</span>
            <span className="costs__num">{money(c.forecast)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="costs__figure">
      <span className="app__label">{label}</span>
      <span className={tone ? `costs__big costs__big--${tone}` : "costs__big"}>{value}</span>
    </div>
  );
}

/** One line under the figures on where "Billed so far" comes from, or why it is empty. */
function BilledNote({ billed }: { billed: Billed }) {
  switch (billed.state) {
    case "ok":
      return (
        <p className="app__note costs__billed-note">
          Billed is Google's own figure, net of credits, from the BigQuery billing export (
          {exportedLabel(billed.exportedAt)}). It trails the estimate by a few hours.
        </p>
      );
    case "notEnabled":
      return (
        <p className="app__note costs__billed-note">
          Billed cost appears once the Cloud Billing export to BigQuery is on. Enable the BigQuery
          API in this project, then in the Console open Billing → Billing export, and send the
          standard usage cost export to the <code>{billed.dataset}</code> dataset in this project.
        </p>
      );
    case "unavailable":
      return (
        <p className="app__error costs__billed-note">
          Could not read the billing export: {billed.message}
        </p>
      );
  }
}

/** The export's month so far, one row per Google Cloud service. */
function BilledTable({ billed }: { billed: Extract<Billed, { state: "ok" }> }) {
  return (
    <section className="costs__category" aria-label="Billed by service">
      <h2 className="costs__heading">
        <span>Billed by service</span>
        <span className="costs__heading-sums">
          <span className="costs__num">{money(billed.net)}</span> net ·{" "}
          {exportedLabel(billed.exportedAt)}
        </span>
      </h2>
      <div className="costs__table-wrap">
        <table className="costs__table">
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col" className="costs__right">
                Cost
              </th>
              <th scope="col" className="costs__right">
                Credits
              </th>
              <th scope="col" className="costs__right">
                Net
              </th>
            </tr>
          </thead>
          <tbody>
            {billed.services.map((s) => (
              <tr key={s.service}>
                <td>{s.service}</td>
                <td className="costs__right costs__num">{money(s.cost)}</td>
                <td className="costs__right costs__num costs__dim">
                  {s.credits === 0 ? "—" : `−${money(-s.credits)}`}
                </td>
                <td className="costs__right costs__num">{money(s.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** One category: a row per billed item, grouped under its resource. */
function CategoryTable({ category }: { category: Category }) {
  const groups = byResource(category.lines);
  return (
    <section className="costs__category" aria-label={category.label}>
      <h2 className="costs__heading">
        <span>{category.label}</span>
        <span className="costs__heading-sums">
          <span className="costs__num">{money(category.toDate)}</span> so far ·{" "}
          <span className="costs__num">{money(category.forecast)}</span> forecast
        </span>
      </h2>
      <div className="costs__table-wrap">
        <table className="costs__table">
          <thead>
            <tr>
              <th scope="col">Resource</th>
              <th scope="col">Billed for</th>
              <th scope="col" className="costs__right">
                Used so far
              </th>
              <th scope="col" className="costs__right">
                List price
              </th>
              <th scope="col" className="costs__right">
                So far
              </th>
              <th scope="col" className="costs__right">
                Forecast
              </th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.resource} className="costs__group">
              {g.lines.map((line, i) => (
                <tr key={line.item}>
                  {i === 0 && (
                    <th scope="rowgroup" rowSpan={g.lines.length} className="costs__resource">
                      <span className="costs__resource-name">{g.resource}</span>
                      <span className="costs__resource-detail">{g.detail}</span>
                    </th>
                  )}
                  <td title={line.sku ?? undefined}>
                    {line.item}
                    {line.note && <span className="costs__note">{line.note}</span>}
                  </td>
                  <td className="costs__right costs__num">
                    {quantity(line.quantityToDate, line.unit)}
                  </td>
                  <td className="costs__right costs__num costs__dim">
                    {unitPrice(line.unitPrice, line.unit)}
                  </td>
                  <td className="costs__right costs__num">
                    {line.unitPrice === null ? "—" : money(line.toDate)}
                  </td>
                  <td className="costs__right costs__num">
                    {line.unitPrice === null ? "—" : money(line.forecast)}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}

function Caveats({ estimate }: { estimate: Estimate }) {
  return (
    <section className="costs__caveats" aria-label="What this estimate leaves out">
      <h2 className="app__label">Not in this estimate</h2>
      <ul>
        {estimate.notEstimated.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <p className="app__note">
        List prices times measured usage — an estimate, not the bill. The forecast runs the last
        seven days' rate to the end of the month; disks and reserved IPs bill for the whole month
        they exist.
      </p>
    </section>
  );
}

/** The whole-pane state for a failure nothing else can get past. */
function Blocked({ failure, onRetry }: { failure: unknown; onRetry: () => void }) {
  return <TroubleNote failure={failure} subject="Cost" onRetry={onRetry} />;
}
