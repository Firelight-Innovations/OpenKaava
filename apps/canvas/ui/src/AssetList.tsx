import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { listAssets, messageOf } from "./rpc";
import {
  STATUSES,
  filterRows,
  issuesOfStored,
  statusOf,
  summarise,
  type AssetsResult,
  type SpecStatus,
} from "./spec";

interface Props {
  /** Changes when the list should be read again (a save, a canvas switch). */
  refreshKey: number;
  onOpen: (canvas: string) => void;
}

/**
 * Every spec card in every canvas of the checkout, with its review state
 * (P7-5). Read from disk on each visit, so a `git pull` shows up.
 */
export default function AssetList({ refreshKey, onOpen }: Props) {
  const [result, setResult] = useState<AssetsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SpecStatus | null>(null);

  useEffect(() => {
    let live = true;
    listAssets()
      .then((r) => {
        if (live) {
          setResult(r);
          setError(null);
        }
      })
      .catch((err) => {
        if (live) setError(messageOf(err));
      });
    return () => {
      live = false;
    };
  }, [refreshKey]);

  const rows = useMemo(() => filterRows(result?.cards ?? [], filter), [result, filter]);
  const summary = useMemo(() => summarise(result?.cards ?? []), [result]);

  if (error) {
    return (
      <div className="cv__empty" role="alert">
        <AlertTriangle size={20} aria-hidden />
        <p>{error}</p>
      </div>
    );
  }
  if (!result) return <div className="cv__empty">Loading...</div>;

  return (
    <section className="cv__assets" aria-label="Asset list">
      <div className="cv__assets-bar" role="group" aria-label="Filter by review state">
        <button
          type="button"
          className={`cv__chip${filter === null ? " is-on" : ""}`}
          aria-pressed={filter === null}
          onClick={() => setFilter(null)}
        >
          All {summary.total}
        </button>
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className={`cv__chip${filter === s ? " is-on" : ""}`}
            aria-pressed={filter === s}
            onClick={() => setFilter(s)}
          >
            {s} {summary.byStatus[s]}
          </button>
        ))}
        <span className="cv__spacer" />
        <small>
          {result.canvases} {result.canvases === 1 ? "canvas" : "canvases"}
        </small>
      </div>

      {result.unreadable.length > 0 && (
        <div className="cv__notice cv__notice--warn" role="alert">
          <AlertTriangle size={14} aria-hidden />
          <span>
            Could not read {result.unreadable.join(", ")}. Cards in{" "}
            {result.unreadable.length === 1 ? "it are" : "them are"} not listed.
          </span>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="cv__empty">
          <p>
            {summary.total === 0
              ? "No spec cards yet. Select a shape on a canvas and fill in its spec card."
              : `No cards are in the ${filter} state.`}
          </p>
        </div>
      ) : (
        <table className="cv__table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Canvas</th>
              <th>Size (m)</th>
              <th>Triangles</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const incomplete = Object.keys(issuesOfStored(row.spec)).length > 0;
              const state = statusOf(row);
              return (
                <tr key={`${row.canvas}:${row.elementId}`}>
                  <td>
                    {typeof row.spec.name === "string" && row.spec.name !== "" ? (
                      row.spec.name
                    ) : (
                      <em>unnamed</em>
                    )}
                    {incomplete && (
                      <span className="cv__warn" title="This card is missing required fields.">
                        {" "}
                        incomplete
                      </span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="cv__crumb-link"
                      onClick={() => onOpen(row.canvas)}
                    >
                      {row.canvasTitle}
                    </button>
                  </td>
                  <td>{typeof row.spec.size_m === "number" ? row.spec.size_m : ""}</td>
                  <td>
                    {typeof row.spec.triangle_budget === "number" ? row.spec.triangle_budget : ""}
                  </td>
                  <td>
                    <span className={`cv__state cv__state--${state}`}>{state}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="cv__hint">
        The state is the card&apos;s own. The cloud build status of the asset is not shown here yet.
      </p>
    </section>
  );
}
