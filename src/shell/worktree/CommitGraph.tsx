/**
 * The commit graph — a vertical lane diagram of a repository's history,
 * newest commit at the top. Renders whatever `WorktreeControl.graph` returns
 * (`../contract`'s `GitCommit[]`, already newest-first) with one row per
 * commit and a small SVG per row for the lane lines that connect it to its
 * parents.
 *
 * The layout math (which column a commit sits in) lives in `layoutCommits`
 * below, kept separate from rendering and exported so it can be tested
 * without a DOM. Everything after that is mechanical: turn lane numbers into
 * x-coordinates and draw lines.
 *
 * Rows are a fixed `ROW_H` pixels tall and each row's `<svg>` is drawn in real
 * pixels, so a node is a true circle and a fork or merge is a short curve that
 * lands on a node or on the lane it joins. The lane column is capped at
 * `MAX_COLS` columns; lanes beyond the cap share the last column rather than
 * widening the graph, so commit messages always keep most of the row.
 */
import { useMemo, useRef } from "react";
import type { GitCommit, GitWorktree } from "../contract";
import { GitBranch } from "../../ui/Icon";
import { focusWithoutScrolling } from "./rowFocus";
import "./commitGraph.css";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * One commit, placed into a lane, with enough of the surrounding lane state
 * to draw every line that touches its row.
 *
 * `lanesBefore`/`lanesAfter` are snapshots of the *whole* lane array — index
 * is the column, value is the sha that column is waiting to see next, or
 * `null` if the column is free — taken immediately before and after this
 * commit was placed. They are intentionally not trimmed to the commit's own
 * neighbourhood: keeping the full array on every row means a row can be
 * rendered on its own, with no lookup into the row above or below it, which
 * is what let the SVG in `CommitRow` stay a pure function of one `PlacedCommit`.
 */
export interface PlacedCommit {
  commit: GitCommit;
  /** The column this commit's own node sits in. */
  lane: number;
  lanesBefore: (string | null)[];
  lanesAfter: (string | null)[];
  /** Columns of lanes that already wait for one of this merge's extra parents.
   *  The merge draws a curve onto that lane instead of opening a duplicate. */
  forksInto: number[];
}

/**
 * Assigns every commit a lane (column index) by walking the list newest to
 * oldest and tracking, per lane, which sha that lane is waiting to see next.
 * The two placement rules are documented on the statements that apply them.
 *
 * Because lanes are only ever reused or appended, never removed, `lane` is
 * never negative and never `NaN`, and a parent sha that never appears later
 * in `commits` (history truncated by the row limit) simply leaves its lane
 * waiting forever — the array carries a lane nothing will ever resolve, and
 * `CommitRow` draws that as a line that runs to the bottom of the list and
 * stops, rather than a crash.
 */
export function layoutCommits(commits: GitCommit[]): PlacedCommit[] {
  const lanes: (string | null)[] = [];
  const placed: PlacedCommit[] = [];

  for (const commit of commits) {
    const lanesBefore = lanes.slice();

    // The invariant that makes this work: a lane's value is always "the sha
    // that will justify this lane's next line downward." A commit claims
    // whichever lane is already waiting for its own sha — that is what makes a
    // fork's two children land in different lanes while their shared parent
    // lands back in the lane that got there first, drawing the two lanes
    // converging into one. A commit nothing is waiting for (a branch tip, or
    // the very first commit this function sees) has no lane to inherit, so it
    // takes the first free column or opens a new one on the right.
    let lane = lanes.indexOf(commit.sha);
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(null);
      }
    }

    // A second (or third...) lane also waiting for this exact sha is another
    // child of the same parent — a fork converging back together here. It is
    // absorbed into `lane` and closed; it never gets its own lane again.
    for (let i = 0; i < lanes.length; i++) {
      if (i !== lane && lanes[i] === commit.sha) lanes[i] = null;
    }

    // The lane is handed to the first parent — the ordinary, non-merge case,
    // where a lane just continues downward under a new sha. Every *additional*
    // parent (two or more means this commit is a merge) opens another lane for
    // itself, reusing a free column before appending one, so a history with
    // many merges does not grow one column per merge forever. A commit with no
    // parents (a root) hands its lane nothing, which closes it.
    lanes[lane] = commit.parents[0] ?? null;
    const forksInto: number[] = [];
    for (let p = 1; p < commit.parents.length; p++) {
      const existing = lanes.indexOf(commit.parents[p]);
      if (existing !== -1) {
        // Another branch already leads to this parent: join it, do not open a
        // second lane for the same sha.
        forksInto.push(existing);
        continue;
      }
      let mergeLane = lanes.indexOf(null);
      if (mergeLane === -1) {
        mergeLane = lanes.length;
        lanes.push(null);
      }
      lanes[mergeLane] = commit.parents[p];
    }

    placed.push({ commit, lane, lanesBefore, lanesAfter: lanes.slice(), forksInto });
  }

  return placed;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Width of one lane column, in px. Tight on purpose: the message column is
 *  what tells one commit from the next. */
const LANE_W = 12;
const NODE_R = 4;
/** Row height in px: a message line over a hash/author/time line. */
const ROW_H = 40;
const ROW_MID = ROW_H / 2;
/** Most lane columns drawn. Lanes past this share the last column. */
export const MAX_COLS = 4;

/** Radius of the halo ring drawn around HEAD and live-branch tips. */
const NODE_RING_R = NODE_R + 3;

/** Lane colours, cycled by lane index: a small palette of tokens that hold up
 *  in both themes. The colour carries no meaning beyond "which lane". */
const LANE_COLORS = [
  "var(--accent)",
  "var(--ok)",
  "var(--warn)",
  "var(--err)",
  "var(--graph-blue)",
  "var(--graph-violet)",
];

export function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

/** The drawn column for a lane: lanes past the cap collapse into the last. */
function col(lane: number): number {
  return Math.min(lane, MAX_COLS - 1);
}

function laneX(lane: number): number {
  return col(lane) * LANE_W + LANE_W / 2;
}

/** A straight segment, in row pixels. */
function straight(x1: number, y1: number, x2: number, y2: number): string {
  return `M ${x1} ${y1} L ${x2} ${y2}`;
}

/** An S-curve between two lanes, flat where it leaves each end so a lane
 *  change reads as a short bend rather than a diagonal slash. */
function curve(x1: number, y1: number, x2: number, y2: number): string {
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

/** One drawn line, already coloured by the lane it belongs to. */
export interface Segment {
  d: string;
  /** A `var(--...)` token from `LANE_COLORS`, chosen by the lane this line runs
   *  in: for a curve, the end that is *not* the node. */
  stroke: string;
}

/**
 * Every line segment this row's `<svg>` needs, derived purely from `placed`'s
 * own before/after snapshots, so a row renders in isolation.
 *
 * Each segment is coloured by its own lane, not the row's, so one continuous
 * branch keeps one colour. A curve takes the lane of the end that is not the
 * node. y is 0 / `ROW_MID` / `ROW_H`: top edge, node centre, bottom edge.
 */
export function rowSegments(placed: PlacedCommit): Segment[] {
  const segments: Segment[] = [];
  const laneCount = Math.max(placed.lanesBefore.length, placed.lanesAfter.length);
  const ownX = laneX(placed.lane);

  for (let idx = 0; idx < laneCount; idx++) {
    const before = placed.lanesBefore[idx] ?? null;
    const after = placed.lanesAfter[idx] ?? null;
    const x = laneX(idx);

    if (idx === placed.lane) {
      // The node's own column: a line in from above if something was waiting
      // for this commit, a line out below to its first parent.
      if (before !== null) segments.push({ d: straight(x, 0, x, ROW_MID), stroke: laneColor(idx) });
      if (after !== null) {
        segments.push({ d: straight(x, ROW_MID, x, ROW_H), stroke: laneColor(idx) });
      }
      continue;
    }

    if (before !== null && before === placed.commit.sha) {
      // Another lane was also waiting for this sha: a fork converging here.
      segments.push({ d: curve(x, 0, ownX, ROW_MID), stroke: laneColor(idx) });
      // The freed column can be reused at once by this merge's extra parent.
      if (after !== null)
        segments.push({ d: curve(ownX, ROW_MID, x, ROW_H), stroke: laneColor(idx) });
      continue;
    }

    if (before !== null && after !== null && before === after) {
      // Untouched by this commit: a lane just passing through this row.
      segments.push({ d: straight(x, 0, x, ROW_H), stroke: laneColor(idx) });
      if (placed.forksInto.includes(idx)) {
        segments.push({ d: curve(ownX, ROW_MID, x, ROW_H), stroke: laneColor(idx) });
      }
      continue;
    }

    if (before === null && after !== null) {
      // A column that did not exist above but does below is a merge parent
      // this commit just opened: draw the branch out of the node.
      segments.push({ d: curve(ownX, ROW_MID, x, ROW_H), stroke: laneColor(idx) });
    }
  }

  return segments;
}

/** A commit's refs split into the pills shown in full and the ones folded into
 *  a "+N" chip. */
export interface RefSplit {
  shown: string[];
  hidden: string[];
}

/**
 * Up to two refs stay readable: the current branch and HEAD when present,
 * else the first. Two or fewer refs are all shown. Everything else is hidden
 * behind the chip, whose tooltip lists it.
 */
export function splitRefs(refs: string[], activeBranch: string | null): RefSplit {
  if (refs.length <= 2) return { shown: refs, hidden: [] };
  const rank = (r: string) => (r === activeBranch ? 0 : r === "HEAD" ? 1 : 2);
  const ordered = [...refs].sort((a, b) => rank(a) - rank(b));
  const prominent = ordered.filter((r) => rank(r) < 2);
  const shown = prominent.length > 0 ? prominent : ordered.slice(0, 1);
  return { shown, hidden: ordered.filter((r) => !shown.includes(r)) };
}

export interface CommitGraphProps {
  /** Newest first, as `WorktreeControl.graph` returns it. */
  commits: GitCommit[];
  /** The message from a failed history read. Shown instead of "No commits",
   *  which would claim the repository is empty when it merely could not be read. */
  error?: string | null;
  worktrees: GitWorktree[];
  /** The branch the current cluster is on — highlighted distinctly from any
   *  other branch that merely has a worktree somewhere. */
  activeBranch: string | null;
  onSelect?: (sha: string) => void;
  selected?: string | null;
}

export default function CommitGraph({
  commits,
  error,
  worktrees,
  activeBranch,
  onSelect,
  selected,
}: CommitGraphProps) {
  const placed = useMemo(() => layoutCommits(commits), [commits]);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Only a branch with a live checkout is worth badging — see the prop doc.
  // `GitWorktree.branch` is null for a detached HEAD, which is not a name
  // any ref could match, so it is filtered out rather than compared.
  const liveBranches = useMemo(
    () => new Set(worktrees.map((w) => w.branch).filter((b): b is string => b !== null)),
    [worktrees],
  );

  // A commit is "prominent" — larger node, halo ring — if it's checked out
  // *somewhere*: the active cluster's own HEAD and the tip of any other
  // branch with a live worktree both read the same way, per `GitWorktree.head`
  // rather than `refs`, because `head` is the exact sha git has checked out
  // while a ref array can list a branch name against a commit with nothing
  // pointing a working tree at it at all.
  const prominentShas = useMemo(() => new Set(worktrees.map((w) => w.head)), [worktrees]);

  const laneCount = Math.min(
    MAX_COLS,
    placed.reduce((max, p) => Math.max(max, p.lanesBefore.length, p.lanesAfter.length), 0),
  );

  if (error) {
    return (
      <div className="commitgraph__quiet commitgraph__error" role="alert">
        Could not read history: {error}
      </div>
    );
  }

  if (placed.length === 0) {
    return <div className="commitgraph__quiet">No commits</div>;
  }

  const moveSelection = (from: string | null | undefined, delta: number) => {
    if (!onSelect) return;
    const index = from ? placed.findIndex((p) => p.commit.sha === from) : -1;
    const next =
      placed[
        clamp(
          index === -1 ? (delta > 0 ? 0 : placed.length - 1) : index + delta,
          0,
          placed.length - 1,
        )
      ];
    onSelect(next.commit.sha);
    rowRefs.current.get(next.commit.sha)?.focus();
  };

  return (
    <div
      className="commitgraph"
      role="listbox"
      aria-label="Commit history"
      onKeyDown={(e) => {
        // Roving focus over a controlled `selected` prop rather than local
        // state: the caller owns which commit is selected (it likely also
        // drives a diff or detail pane from it), so a key press has to go
        // through `onSelect` the same way a click does, not sidestep it.
        if (e.key === "ArrowDown") {
          e.preventDefault();
          moveSelection(selected, 1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          moveSelection(selected, -1);
        } else if (e.key === "Home") {
          e.preventDefault();
          onSelect?.(placed[0].commit.sha);
          rowRefs.current.get(placed[0].commit.sha)?.focus();
        } else if (e.key === "End") {
          e.preventDefault();
          const last = placed[placed.length - 1];
          onSelect?.(last.commit.sha);
          rowRefs.current.get(last.commit.sha)?.focus();
        }
      }}
    >
      {placed.map((p, i) => (
        <CommitRow
          key={p.commit.sha}
          placed={p}
          laneCount={laneCount}
          liveBranches={liveBranches}
          activeBranch={activeBranch}
          prominent={prominentShas.has(p.commit.sha)}
          selected={selected === p.commit.sha}
          tabIndex={selected ? (selected === p.commit.sha ? 0 : -1) : i === 0 ? 0 : -1}
          onSelect={onSelect}
          rowRef={(el) => {
            if (el) rowRefs.current.set(p.commit.sha, el);
            else rowRefs.current.delete(p.commit.sha);
          }}
        />
      ))}
    </div>
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function CommitRow({
  placed,
  laneCount,
  liveBranches,
  activeBranch,
  prominent,
  selected,
  tabIndex,
  onSelect,
  rowRef,
}: {
  placed: PlacedCommit;
  laneCount: number;
  liveBranches: Set<string>;
  activeBranch: string | null;
  prominent: boolean;
  selected: boolean;
  tabIndex: number;
  onSelect?: (sha: string) => void;
  rowRef: (el: HTMLDivElement | null) => void;
}) {
  const { commit } = placed;
  const segments = useMemo(() => rowSegments(placed), [placed]);
  const { shown, hidden } = useMemo(
    () => splitRefs(commit.refs, activeBranch),
    [commit.refs, activeBranch],
  );

  const classes = ["commitgraph__row"];
  if (selected) classes.push("commitgraph__row--selected");

  return (
    <div
      ref={rowRef}
      className={classes.join(" ")}
      role="option"
      aria-selected={selected}
      tabIndex={onSelect ? tabIndex : undefined}
      // These rows are focusable and `.worktreepanel__graph-scroll` scrolls, so
      // an edge row had the same unclickable defect the change lists did — see
      // `focusWithoutScrolling`. Mouse only: the arrow-key roving below focuses
      // rows *without* this, and must keep scrolling them into view.
      onMouseDown={focusWithoutScrolling}
      onClick={() => onSelect?.(commit.sha)}
    >
      <svg
        className="commitgraph__lines"
        width={laneCount * LANE_W}
        height={ROW_H}
        viewBox={`0 0 ${laneCount * LANE_W} ${ROW_H}`}
        aria-hidden="true"
      >
        {segments.map((segment, i) => (
          <path
            key={i}
            d={segment.d}
            className="commitgraph__line"
            style={{ stroke: segment.stroke }}
          />
        ))}
        {prominent && (
          <circle
            className="commitgraph__node-ring"
            cx={laneX(placed.lane)}
            cy={ROW_MID}
            r={NODE_RING_R}
            style={{ stroke: laneColor(placed.lane) }}
          />
        )}
        <circle
          className="commitgraph__node"
          cx={laneX(placed.lane)}
          cy={ROW_MID}
          r={NODE_R}
          style={{ fill: laneColor(placed.lane) }}
        />
      </svg>

      <div className="commitgraph__body">
        <span className="commitgraph__summary" title={commit.summary}>
          {commit.summary}
        </span>
        <div className="commitgraph__sub">
          {commit.refs.length > 0 && (
            <span className="commitgraph__refs">
              {shown.map((ref) => (
                <RefBadge
                  key={ref}
                  name={ref}
                  active={ref === activeBranch}
                  live={liveBranches.has(ref)}
                />
              ))}
              {hidden.length > 0 && (
                <span className="commitgraph__ref commitgraph__ref--more" title={hidden.join(", ")}>
                  +{hidden.length}
                </span>
              )}
            </span>
          )}
          <span className="commitgraph__meta">
            <span className="commitgraph__sha" title={commit.sha}>
              {commit.short}
            </span>
            <span className="commitgraph__author" title={commit.author}>
              {commit.author}
            </span>
            <span className="commitgraph__when" title={exactTime(commit.when)}>
              {relativeTime(commit.when)}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** A branch ref chip. Three treatments, ascending: a plain local branch with
 *  no checkout is dim text (it is history, not something you could switch
 *  into from here); one with a live worktree gets the branch glyph and a
 *  surface behind it; the active cluster's own branch gets the accent wash
 *  instead of the neutral one, which is the same "this one" language the
 *  accent already carries everywhere else in the shell.
 *
 *  `title` because the chip itself is capped and ellipsised in CSS — a branch
 *  named for a ticket and its whole summary is a real thing people cut, and
 *  before the cap one of them pushed the sha, author and date off the row
 *  entirely. */
function RefBadge({ name, active, live }: { name: string; active: boolean; live: boolean }) {
  const classes = ["commitgraph__ref"];
  if (live) classes.push("commitgraph__ref--live");
  if (active) classes.push("commitgraph__ref--active");

  return (
    <span className={classes.join(" ")} title={name}>
      {live && <GitBranch size={9} strokeWidth={2} />}
      <span className="commitgraph__ref-name">{name}</span>
    </span>
  );
}

/**
 * A compact "3m", "2h", "5d" style stamp rather than `Intl.RelativeTimeFormat`'s
 * "3 minutes ago" — this column sits to the right of the summary in a panel
 * that can be dragged down to 240px, and the verbose form is the first thing
 * that would have to go missing to fit.
 */
function relativeTime(unixSeconds: number): string {
  const deltaSeconds = Math.max(0, Date.now() / 1000 - unixSeconds);
  const steps: [number, string][] = [
    [60, "s"],
    [60, "m"],
    [24, "h"],
    [7, "d"],
    [4.345, "w"],
    [12, "mo"],
    [Infinity, "y"],
  ];

  let value = deltaSeconds;
  for (const [span, unit] of steps) {
    if (value < span) return `${Math.max(1, Math.floor(value))}${unit}`;
    value /= span;
  }
  return `${Math.floor(value)}y`;
}

/**
 * The same instant, in full, for the stamp's tooltip.
 *
 * The viewer's own locale and zone, with no format string: a commit time means
 * "when it happened here", and every other date this shell shows a person is
 * left to `Intl` for the same reason. `GitCommit.when` is Unix **seconds**,
 * which is the multiplication this and `relativeTime` both exist to remember.
 */
function exactTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
