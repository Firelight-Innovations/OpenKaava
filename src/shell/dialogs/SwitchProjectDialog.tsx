/**
 * The Switch Project dialog (board 08, "Switch project, restore state") —
 * the title-bar project pill's dropdown. Lists every project OpenKaava
 * remembers opening, lets you filter them by name, and switches the active
 * cluster to whichever one you pick.
 *
 * The full board draws a **restore toast** alongside this dialog — "2
 * environments · 6 panes · cloud stream reattached · Git docked" — depicting
 * KAAVA-UX-REWORK.md §6's restore order (environments, then clusters, then
 * tabs, then right page). That toast, and the layout it describes, depend on
 * the per-project workspace file §6 defines; nothing persists one yet, so
 * this dialog only does the one thing that is real today — pointing the
 * active cluster at a different project through `openProjectInCluster`,
 * the same path Home's own Recent list uses. The summary line below is
 * built only from counts `list_recent_projects` actually answers (see
 * `RecentProjectRow`'s own doc on why `format`/`modified`/pane counts and
 * the board's status chips are left out rather than invented).
 *
 * The title-bar pill itself is not wired to open this yet — see this PR's
 * description for why (`TitleBar.tsx`'s title block is `pointer-events:
 * none` by design, and is mid-restyle on a parallel branch).
 */
import { useEffect, useMemo, useState } from "react";
import Dialog from "./Dialog";
import "./SwitchProjectDialog.css";
import { listRecentProjects, openProjectInCluster, type RecentProjectRow } from "../../bindings";

export interface SwitchProjectDialogProps {
  /** Where a chosen project opens into. Every row still renders with this
   *  `null` (e.g. a window whose last cluster just closed) — see `Dialog`'s
   *  own contract — but nothing is clickable until there is somewhere for
   *  the choice to land. */
  clusterId: string | null;
  onCancel: () => void;
  /** `open_project_in_cluster` succeeded. */
  onOpened: () => void;
  /** File > Open… — the same native folder picker its own button raises. */
  onOpenFolder: () => void;
  /** Home's own "New project". */
  onNewProject: () => void;
}

export default function SwitchProjectDialog({
  clusterId,
  onCancel,
  onOpened,
  onOpenFolder,
  onNewProject,
}: SwitchProjectDialogProps) {
  const [rows, setRows] = useState<RecentProjectRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void listRecentProjects()
      .then((found) => {
        if (live) setRows(found);
      })
      .catch(() => {
        // "Nothing to show" reads the same as "nothing remembered" — the
        // Recent list itself is not something this dialog can repair.
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
  }, []);

  const filtered = useMemo(() => {
    if (rows === null) return null;
    const needle = query.trim().toLowerCase();
    if (needle === "") return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(needle));
  }, [rows, query]);

  const open = (row: RecentProjectRow) => {
    if (clusterId === null || pending !== null || !row.exists) return;
    setPending(row.path);
    setFailure(null);
    openProjectInCluster(clusterId, row.path)
      .then(onOpened)
      .catch((e: unknown) => {
        setPending(null);
        setFailure(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
      });
  };

  return (
    <Dialog label="Switch project" onCancel={onCancel} className="switch-project">
      <div className="switch-project__search">
        <span className="switch-project__search-icon" aria-hidden="true">
          ⌕
        </span>
        <input
          type="text"
          className="switch-project__search-field"
          placeholder="Switch project…"
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="switch-project__search-hint">Ctrl Alt P</span>
      </div>

      <div className="switch-project__list" role="listbox" aria-label="Recent projects">
        {filtered === null ? (
          <p className="switch-project__empty">Looking…</p>
        ) : filtered.length === 0 ? (
          <p className="switch-project__empty">
            {rows && rows.length > 0 ? "No project matches." : "No projects opened yet."}
          </p>
        ) : (
          filtered.map((row) => (
            <ProjectRow
              key={row.path}
              row={row}
              busy={pending === row.path}
              disabled={clusterId === null || (pending !== null && pending !== row.path)}
              onOpen={() => open(row)}
            />
          ))
        )}
      </div>

      {failure && <p className="switch-project__error">{failure}</p>}

      <footer className="switch-project__footer">
        <div className="switch-project__actions">
          <button type="button" className="switch-project__ghost" onClick={onOpenFolder}>
            Open folder…
          </button>
          <button type="button" className="switch-project__ghost" onClick={onNewProject}>
            New project
          </button>
        </div>
        <p className="switch-project__note">Agents keep running when you switch away.</p>
      </footer>
    </Dialog>
  );
}

interface ProjectRowProps {
  row: RecentProjectRow;
  busy: boolean;
  disabled: boolean;
  onOpen: () => void;
}

function ProjectRow({ row, busy, disabled, onOpen }: ProjectRowProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={row.open}
      className="switch-project__row"
      disabled={disabled}
      onClick={onOpen}
    >
      <span className="switch-project__tile" aria-hidden="true">
        {row.name.charAt(0).toUpperCase() || "?"}
      </span>
      <span className="switch-project__row-main">
        <span className="switch-project__row-head">
          <span className="switch-project__row-name">{row.name}</span>
          {row.open && <span className="switch-project__badge">OPEN</span>}
        </span>
        <span className="switch-project__row-summary">{summaryOf(row, busy)}</span>
      </span>
      <span className="switch-project__row-time">{relativeTime(row.lastOpened)}</span>
    </button>
  );
}

/** The one-line layout summary, built only from what `RecentProjectRow`
 *  actually answers — see the file header for why the board's fuller line
 *  ("4 panes · Git docked") is not reproduced here. */
function summaryOf(row: RecentProjectRow, busy: boolean): string {
  if (busy) return "Opening…";
  if (!row.exists) return "Folder not found.";
  if (!row.open) return row.initialized ? "Not open." : "Never opened in Kaava.";
  const envs = row.environmentCount;
  const clusters = row.clusterCount;
  return `${envs} environment${envs === 1 ? "" : "s"} · ${clusters} cluster${clusters === 1 ? "" : "s"}`;
}

/** "now" / "2h ago" / "yesterday" / "last week", the board's own granularity.
 *  `null` (never opened) reads as an empty cell rather than "—", the same
 *  "no answer, no placeholder" rule `TitleBar.tsx` uses for a dropped segment. */
function relativeTime(lastOpened: number | null): string {
  if (lastOpened === null) return "";
  const ms = Date.now() - lastOpened;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 14) return "last week";
  return `${Math.floor(days / 7)}w ago`;
}
