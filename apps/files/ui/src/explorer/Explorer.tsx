/**
 * The file tree: a header, a filter, and a windowed list of rows.
 *
 * Rooted on the open project and unable to leave it. There is no "up" button
 * and no breadcrumb, because `files/root` is the boundary the backend enforces
 * anyway — offering a way out of it would only be offering an error.
 *
 * This file owns the parts that need to see the whole tree at once: where the
 * keyboard is, what the filter says, and which row was right-clicked. The tree's
 * contents are `useTree.ts`, which slice of them is in the DOM is
 * `useVirtualRows.ts`, and a row's markup is `TreeRow.tsx`.
 *
 * No motion anywhere, and no framer-motion import at all — see `TreeRow.tsx`'s
 * header, and `src/shell/worktree/WorktreeView.tsx` for the rule both inherit.
 * It used to appear here for exactly one thing, the pane's own width during a
 * splitter drag; the splitter went with the editor when Files became two apps,
 * because a pane is the shell's to divide.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { claimSearch, host, type SearchHandle } from "@openkaava/bridge";
import ContextMenu, { type DraftKind, type MenuTarget } from "../ContextMenu";
import DraftRow from "./DraftRow";
import TreeRow, { GUTTER, INDENT } from "./TreeRow";
import { useRowDrag } from "./useRowDrag";
import { useGitStatus } from "./gitStatus";
import { useTree, type Row } from "./useTree";
import { ROW_HEIGHT, scrollRowIntoView, useVirtualRows } from "./useVirtualRows";
import { createDir, createFile, describe, rename, type Root } from "../rpc";
import type { DeleteTarget } from "../useDelete";
import TrashView from "../trash/TrashView";
import "./explorer.css";

/**
 * One line in the scrollport: a tree row, or the field a new entry is being
 * named in.
 *
 * The draft is spliced into this list rather than rendered beside it, and that
 * is the whole reason the windowing arithmetic keeps working while it is open:
 * `useVirtualRows` is handed a count and returns indices, so a list one longer
 * scrolls, pads and windows correctly with no special case anywhere. Appending
 * the field outside the list would have made every index below it disagree with
 * its own pixel position.
 *
 * It is not a `Row`, and deliberately not: a `Row` has an `Entry`, an `Entry`
 * has a path, and a thing being named does not have one yet. Inventing a
 * placeholder path so it could travel as a row would put a fake filesystem
 * entry into the structure the whole tree is derived from.
 */
type Line = { kind: "row"; row: Row } | { kind: "draft"; depth: number };

/** What is being named, and where it will go. */
interface Draft {
  /** Naming something new, or re-naming something that exists. */
  mode: "create" | "rename";
  kind: DraftKind;
  /** The folder involved: where a create lands, or where a rename already is.
   *  It is what gets re-listed when the call succeeds. */
  parent: string;
  /** The entry being renamed. `null` for a create — it has no path yet. */
  path: string | null;
  /** What the field starts with. `""` for a create. */
  initialName: string;
}

/**
 * The two things the title bar's File menu asks of the tree.
 *
 * Imperative rather than props, because both are *events* — "the user just
 * chose New File" — and a prop would have to be a nonce the tree watched for a
 * change in, which is a worse way of saying the same thing. Same reasoning as
 * `TerminalDeck`'s handle in the shell.
 */
export interface ExplorerHandle {
  /** Begin naming a new file, in the folder the cursor is in. */
  newFile(): void;
  /** Show the Recycle Bin list — File > Trash. */
  showTrash(): void;
}

/** What one navigation key does, given where the cursor is. */
type NavHandler = (ctx: NavContext) => void;

/**
 * Everything a navigation key may see and everything it may do.
 *
 * Hoisted out of the component with the table below, because the switch this
 * replaced paid a branch per key for a shape that is entirely regular: look up
 * the row under the cursor, then move, open, close or activate. Nothing here
 * reads React state directly — the component hands over the four callbacks it
 * already built, so a handler cannot reach anything the old `case` could not.
 */
interface NavContext {
  /** Where the cursor is in `lines`, or `-1` when it is nowhere. */
  index: number;
  /** The row at `index`: `null` off the ends, and `null` on the draft line. */
  row: Row | null;
  /** The flat list the indices are into — rows with the draft spliced in. */
  lines: Line[];
  moveTo: (index: number) => void;
  expand: (path: string) => void;
  collapse: (path: string) => void;
  activate: (row: Row) => void;
}

/**
 * The keys the tree answers for, one row each. A key that is not in here is
 * not ours, and `onKeyDown` leaves it to the browser untouched.
 */
const NAV_KEYS: Record<string, NavHandler> = {
  // From nowhere, ↓ lands on the first row: -1 + 1.
  ArrowDown: ({ index, moveTo }) => {
    moveTo(index + 1);
  },

  ArrowUp: ({ index, moveTo }) => {
    if (index > 0) moveTo(index - 1);
  },

  Home: ({ moveTo }) => {
    moveTo(0);
  },

  End: ({ lines, moveTo }) => {
    moveTo(lines.length - 1);
  },

  // A closed directory opens; an open one descends into its first child,
  // which is the next row by construction of the flat array. A file has
  // nowhere to go.
  ArrowRight: ({ index, row, moveTo, expand }) => {
    if (!row) moveTo(0);
    else if (row.entry.kind === "dir") {
      if (row.expanded) moveTo(index + 1);
      else expand(row.entry.path);
    }
  },

  ArrowLeft: ({ row, lines, moveTo, collapse }) => {
    if (row && row.entry.kind === "dir" && row.expanded) {
      collapse(row.entry.path);
    } else if (row) {
      // Ascend. A depth-0 row's parent is the root, which has no row of
      // its own, so this finds nothing and the cursor stays put.
      const parent = lines.findIndex(
        (other) => other.kind === "row" && other.row.entry.path === row.parent,
      );
      if (parent >= 0) moveTo(parent);
    }
  },

  // From nowhere Enter lands on the first row, as ArrowRight does, instead of
  // silently doing nothing on a freshly focused tree.
  Enter: ({ row, activate, moveTo }) => {
    if (row) activate(row);
    else moveTo(0);
  },
};

const Explorer = forwardRef<
  ExplorerHandle,
  {
    root: Root | null;
    /** A change means "drop the cache and re-list whatever is open". */
    reloadNonce: number;
    /**
     * The file showing in the viewer, which may have been opened from a tab.
     *
     * Which file is open is deliberately not this file's to own. It is
     * `App.tsx`'s, arriving here and leaving as `onOpenFile`. The tree can be
     * driven from the tab strip for free as a result, and clicking a row does
     * not have to know what a tab is.
     */
    selectedPath: string | null;
    /**
     * The root has been listed, or has failed to be — the point at which this
     * pane is showing rows rather than the space where rows will go. `App.tsx`
     * takes it as Files' first meaningful frame; nothing else reads it, and it
     * fires once per root.
     */
    onFirstListing: () => void;
    onRefresh: () => void;
    /**
     * Show a file. `preview` is the peek a single click asks for; see `open` in
     * `tabs/useOpenFiles.ts` for what the tab model does with it. The tree still
     * does not know what a tab is — it only says how deliberate the gesture was.
     */
    onOpenFile: (path: string, preview: boolean) => void;
    /**
     * A rename landed on disk. The tab model needs this to move any tab that was
     * pointing at the old path — including tabs *inside* a renamed folder.
     */
    onRenamed: (from: string, to: string) => void;
    /**
     * Ask whether to delete this entry. The tree does not own the question: one
     * confirmation at a time for the whole app, and it is `App.tsx` that knows
     * about open buffers and therefore about what a delete would cost.
     */
    onDelete: (target: DeleteTarget) => void;
    /** The folder an OS file drag is over (the root's own path for blank space), or `null`. */
    dropTarget?: string | null;
  }
>(function Explorer(
  {
    root,
    reloadNonce,
    selectedPath,
    onFirstListing,
    onRefresh,
    onOpenFile,
    onRenamed,
    onDelete,
    dropTarget,
  },
  ref,
) {
  const [filter, setFilter] = useState("");
  // Under the shell the filter is typed in the title bar's search field, which
  // this tree claims while it is showing. Standalone there is no shell to claim
  // from, so the tree draws its own input as it always did.
  const inShell = host() === "kaava";
  /**
   * Where the keyboard is. Separate from `selectedPath` because the two are
   * different facts: the cursor can sit on a directory, or on a file nobody
   * has opened yet, and moving it must not open anything.
   */
  const [cursor, setCursor] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  /**
   * Which list this pane is showing.
   *
   * Two views rather than two panes, because they answer the same question
   * about the same project — what is here, and what used to be — and a second
   * pane would mean deciding how wide it is and what happens to the splitter.
   */
  const [view, setView] = useState<"files" | "trash">("files");
  /** Bumped to re-read the Recycle Bin. The trash view's `reloadNonce`. */
  const [trashNonce, setTrashNonce] = useState(0);
  /** The entry being named, or `null` when nothing is. At most one at a time. */
  const [draft, setDraft] = useState<Draft | null>(null);
  /** Why the last create was refused. Keeps the field up so the name can be fixed. */
  const [draftError, setDraftError] = useState<string | null>(null);
  /** A create is in flight. Freezes the field rather than closing it. */
  const [creating, setCreating] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const searchClaim = useRef<SearchHandle | null>(null);
  useEffect(() => {
    if (!inShell || view !== "files") return;
    const handle = claimSearch({
      placeholder: "Filter files",
      value: "",
      onChange: setFilter,
      onEscape: () => setFilter(""),
    });
    searchClaim.current = handle;
    return () => {
      handle.release();
      searchClaim.current = null;
    };
  }, [inShell, view]);
  useEffect(() => {
    searchClaim.current?.update({ value: filter });
  }, [filter, inShell, view]);

  const tree = useTree(root, reloadNonce, filter);
  const { rows, expand, collapse, relist } = tree;

  // Same `reloadNonce` the tree itself re-lists on: whatever counts as "the
  // project changed underneath us" for the file list counts as it for git
  // status too, and there is no reason for the two to disagree about when
  // that is. The root is passed as well, on its own schedule — see
  // `useGitStatus`, which fetches the far more expensive ignore list once per
  // project rather than on every one of those refreshes.
  const git = useGitStatus(root?.path ?? null, reloadNonce);

  /**
   * The rows, with the draft field spliced in where its entry will land.
   *
   * First child of its folder, rather than in the position the finished name
   * would sort to — which cannot be known while it is still being typed, and
   * would move the field under the cursor with every keystroke if it were
   * recomputed. The listing that follows a successful create puts the real row
   * in its real place.
   */
  const lines = useMemo<Line[]>(() => {
    const out: Line[] = rows.map((row) => ({ kind: "row", row }));
    if (!draft || !root) return out;

    // A rename takes the row's place rather than joining the list beside it.
    if (draft.mode === "rename") {
      const at = rows.findIndex((row) => row.entry.path === draft.path);
      if (at === -1) return out;
      out[at] = { kind: "draft", depth: rows[at].depth };
      return out;
    }

    // The root has no row of its own, so its first child slot is the top.
    if (draft.parent === root.path) {
      out.unshift({ kind: "draft", depth: 0 });
      return out;
    }

    const at = rows.findIndex((row) => row.entry.path === draft.parent);
    // The folder went off screen while the field was open. Rather than put the
    // field somewhere arbitrary, leave it out — the effect below cancels the
    // draft, which is the honest end for a question whose subject has gone.
    if (at === -1) return out;
    out.splice(at + 1, 0, { kind: "draft", depth: rows[at].depth + 1 });
    return out;
  }, [rows, draft, root]);

  const port = useVirtualRows(scrollRef, lines.length);

  // Picking a row up and carrying it to a terminal. One gesture for the tree,
  // handed to each row as props — `useRowDrag.ts` has why this app can start a
  // drag it cannot see the end of.
  const rowDrag = useRowDrag();

  /** The `Row` at a line index, or `null` when that line is the draft. */
  const rowAt = useCallback(
    (index: number): Row | null => {
      const line = lines[index];
      return line && line.kind === "row" ? line.row : null;
    },
    [lines],
  );

  // Told once the root's own listing has come back, or has failed to. Both
  // count: a root that cannot be listed draws its error, and that is as
  // finished as this pane is going to get. `tree.ready` only ever goes from
  // false to true for a given root, and `onFirstListing` is a no-op after the
  // first call, so a re-list does not re-report.
  useEffect(() => {
    if (tree.ready || tree.rootError !== null) onFirstListing();
  }, [tree.ready, tree.rootError, onFirstListing]);

  // Opening a file anywhere — a tab, a jump — brings the cursor with it, so
  // ↓ continues from what is on screen rather than from wherever it last was.
  useEffect(() => {
    if (selectedPath) setCursor(selectedPath);
  }, [selectedPath]);

  // A changed filter re-flattens from the top, so the old scroll offset points
  // at a row that is no longer there. Going back to the top is both the honest
  // answer and what keeps the window from briefly resolving past the new end.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [filter]);

  const cursorIndex = useMemo(
    () =>
      cursor === null
        ? -1
        : lines.findIndex((line) => line.kind === "row" && line.row.entry.path === cursor),
    [lines, cursor],
  );

  const moveTo = useCallback(
    (index: number) => {
      const row = rowAt(index);
      // A move onto the draft line does nothing rather than skipping over it.
      // The keyboard is in the field while a draft is open — `DraftRow` stops
      // its keys reaching the tree — so this is only ever reached by a stray
      // event, and stepping *past* a row the user cannot see the cursor on is
      // worse than not moving.
      if (!row) return;
      setCursor(row.entry.path);
      scrollRowIntoView(scrollRef.current, index);
    },
    [rowAt],
  );

  /**
   * Click, and Enter: a directory opens or closes, a file is peeked at.
   *
   * Enter goes the same way as a single click rather than counting as the
   * deliberate open, because it is the keyboard's equivalent of one — walking a
   * folder with ↓ and Enter is the same browsing gesture as clicking down it,
   * and it should leave the same one tab behind.
   */
  const activate = useCallback(
    (row: Row) => {
      setCursor(row.entry.path);
      if (row.entry.kind === "dir") {
        // The row's own flag, not the collapse set — under a filter those are
        // allowed to differ, and what the chevron shows is what a click owes.
        if (row.expanded) collapse(row.entry.path);
        else expand(row.entry.path);
      } else if (row.entry.kind === "file") {
        onOpenFile(row.entry.path, true);
      }
      // A pipe or a socket is listed and can be pointed at, but there is
      // nothing to show, so it does nothing here.
    },
    [collapse, expand, onOpenFile],
  );

  /** A double-clicked file, which is the user saying they mean to stay. */
  const keep = useCallback(
    (row: Row) => {
      setCursor(row.entry.path);
      onOpenFile(row.entry.path, false);
    },
    [onOpenFile],
  );

  const closeMenu = useCallback(() => {
    setMenu(null);
    // The menu took focus when it opened; without this, Escape would leave the
    // keyboard on the document and the next arrow key would scroll nothing.
    // Skipped while a draft is open: the field takes focus on mount, and this
    // would pull it straight back out again.
    if (!draft) scrollRef.current?.focus({ preventScroll: true });
  }, [draft]);

  /** Put an empty field in the tree and let the user name what goes in it. */
  const beginDraft = useCallback(
    (parent: string, kind: DraftKind) => {
      setDraftError(null);
      setCreating(false);
      setDraft({ mode: "create", kind, parent, path: null, initialName: "" });
      // A closed folder cannot show the field that is going inside it. Opening
      // it is also what the user would have done next anyway.
      if (root && parent !== root.path) expand(parent);
    },
    [expand, root],
  );

  /**
   * Turn a row into a field holding its own name.
   *
   * Only reachable for a row that is on screen, which is what makes `parent`
   * and `kind` findable — the tree already knows both, and taking them from the
   * row rather than from the caller keeps this from being a second place that
   * decides what a path's parent is. A rename asked for from the tab strip does
   * not come here at all; it edits the chip, because the file it names may not
   * be anywhere in this tree.
   */
  const beginRename = useCallback(
    (path: string, name: string) => {
      const row = rows.find((entry) => entry.entry.path === path);
      if (!row) return;
      setDraftError(null);
      setCreating(false);
      setDraft({
        mode: "rename",
        kind: row.entry.kind === "dir" ? "dir" : "file",
        parent: row.parent,
        path,
        initialName: name,
      });
    },
    [rows],
  );

  /**
   * Where a "New …" aimed at `row` creates: a folder row holds it, a file row's
   * folder does, and nothing at all means the project root.
   *
   * One function rather than the expression written twice, because there are
   * now two ways to ask for a new file — the right-click menu and the title
   * bar's File > New File — and two copies of this rule is two rules that will
   * eventually disagree about where a new file goes. `row.parent` is the tree's
   * own fact about a path's folder, which is why this lives here and not
   * anywhere that would have to work it out from the string.
   */
  const createInFor = useCallback(
    (row: Row | null): string | null => {
      if (!root) return null;
      if (!row) return root.path;
      return row.entry.kind === "dir" ? row.entry.path : row.parent;
    },
    [root],
  );

  const cancelDraft = useCallback(() => {
    setDraft(null);
    setDraftError(null);
    setCreating(false);
    scrollRef.current?.focus({ preventScroll: true });
  }, []);

  /**
   * Send the name, and deal with both answers.
   *
   * A refusal — the name is taken, it has a character Windows will not store,
   * the folder is not writable — leaves the field exactly where it is with what
   * was typed still in it, and puts the backend's own sentence above the tree.
   * That is the whole reason `creating` exists rather than the field simply
   * closing on Enter: the common failure here is a fixable typo, and closing
   * the field would make fixing it mean starting over.
   *
   * On success only the one directory is re-read, not the tree — see `relist`.
   * A new file then opens for real rather than as a preview: someone who just
   * named a file means to work in it.
   */
  const commitDraft = useCallback(
    (name: string) => {
      if (!draft) return;
      const { mode, parent, kind, path } = draft;

      const method =
        mode === "rename"
          ? "files/rename"
          : kind === "dir"
            ? "files/create-dir"
            : "files/create-file";

      setCreating(true);
      setDraftError(null);

      const call =
        mode === "rename" && path !== null
          ? rename(path, name)
          : (kind === "dir" ? createDir : createFile)(parent, name);

      void call
        .then((entry) => {
          setDraft(null);
          setCreating(false);
          relist(parent);
          setCursor(entry.path);

          if (mode === "rename" && path !== null) {
            // The tab model has to hear about this before anything re-reads:
            // a tab still pointing at the old path would poll, find nothing,
            // and mark itself missing — a phantom tab for a file that is fine.
            onRenamed(path, entry.path);
          } else if (entry.kind === "dir") {
            expand(entry.path);
          } else {
            // Someone who just named a file means to work in it, so this is a
            // real open rather than a preview.
            onOpenFile(entry.path, false);
          }

          scrollRef.current?.focus({ preventScroll: true });
        })
        .catch((err: unknown) => {
          setCreating(false);
          setDraftError(describe(method, err));
        });
    },
    [draft, expand, onOpenFile, onRenamed, relist],
  );

  /**
   * Abandon a draft whose folder is no longer on screen.
   *
   * Reachable by filtering, and by the tree being re-listed out from under the
   * field. Leaving the state set would strand a `draft` with no row rendering
   * it, and the field would reappear — empty, having been unmounted — whenever
   * the folder came back.
   */
  const orphaned = draft !== null && !lines.some((line) => line.kind === "draft");
  useEffect(() => {
    if (orphaned) cancelDraft();
  }, [orphaned, cancelDraft]);

  /** Bring a newly opened field into view; it may be well below the fold. */
  useEffect(() => {
    if (!draft) return;
    const at = lines.findIndex((line) => line.kind === "draft");
    if (at >= 0) scrollRowIntoView(scrollRef.current, at);
    // Deliberately not on `lines`: this must fire when a draft opens, not
    // every time a folder finishes listing underneath one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  useImperativeHandle(
    ref,
    () => ({
      newFile() {
        // The cursor is where the keyboard is, and it follows every open — so
        // "the folder the cursor is in" is the same place a right-click would
        // have aimed at, resolved by the same function.
        const parent = createInFor(rows.find((row) => row.entry.path === cursor) ?? null);
        if (parent === null) return;
        // A draft cannot be typed into a pane the tree is not on. Switching
        // back is what the user would have done next anyway.
        setView("files");
        beginDraft(parent, "file");
      },
      showTrash() {
        setView("trash");
      },
    }),
    [beginDraft, createInFor, cursor, rows],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // `metaKey` stays in this one, unlike the shell's activation checks: here it
    // only rules a keystroke *out*, and Win+Arrow is a window-manager gesture
    // that must not also move the cursor in the tree.
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const handler: NavHandler | undefined = NAV_KEYS[event.key];
    // Anything else is not ours — leave the browser's default alone.
    if (!handler) return;
    const index = cursorIndex;
    handler({
      index,
      row: index >= 0 ? rowAt(index) : null,
      lines,
      moveTo,
      expand,
      collapse,
      activate,
    });
    // Every key in the table is one the tree handled, including the ones that
    // decided to do nothing. Not preventing here would let ↑/↓ scroll the
    // scrollport out from under the selection they just moved.
    event.preventDefault();
  };

  /**
   * The one line above the tree, and what gets to use it.
   *
   * A refused create outranks everything: it is the answer to something the
   * user just did, and it is the only place the reason can go — the field it
   * belongs to lives inside a `role="tree"`, which may hold nothing but tree
   * items. While a draft is open and nothing has failed, the empty-folder note
   * is suppressed rather than shown beside the field: "This folder is empty" is
   * about to stop being true, and it is the folder the field is in.
   */
  const note = draftError
    ? { className: "app__error", text: draftError }
    : draft
      ? null
      : emptyNote(tree.rootError, tree.ready, rows.length, filter);

  return (
    <div
      className="explorer"
      // The row height reaches CSS from the one place it is written down, so
      // `explorer.css` and the windowing arithmetic cannot drift apart.
      style={{ "--explorer-row": `${ROW_HEIGHT}px` } as CSSProperties}
    >
      <div className="explorer__head">
        <span className="app__label explorer__root">
          {view === "trash" ? "Deleted" : root ? root.name : "No project"}
        </span>
        <button
          type="button"
          className="explorer__refresh"
          data-on={view === "trash" || undefined}
          onClick={() => setView(view === "trash" ? "files" : "trash")}
          title={view === "trash" ? "Back to the file tree" : "Show what this project has deleted"}
          aria-label={view === "trash" ? "Show the file tree" : "Show deleted files"}
          aria-pressed={view === "trash"}
        >
          <Bin />
        </button>
        <button
          type="button"
          className="explorer__refresh"
          // In the trash view this re-reads the Recycle Bin instead of the
          // folders, which is the same promise — "show me what is there now" —
          // about whichever list is on screen.
          onClick={() => (view === "trash" ? setTrashNonce((n) => n + 1) : onRefresh())}
          title={view === "trash" ? "Re-read the Recycle Bin" : "Re-read the folders that are open"}
          aria-label={view === "trash" ? "Refresh the deleted list" : "Refresh the file tree"}
        >
          <Refresh />
        </button>
      </div>

      {view === "trash" && (
        <TrashView
          root={root}
          reloadNonce={trashNonce}
          // A restored file is back in the tree, which is behind this view and
          // now out of date. Refreshing it here means switching back shows the
          // file rather than the gap it left.
          onRestored={onRefresh}
        />
      )}

      {/* The tree and everything that belongs to it. Unmounted in the trash
          view rather than hidden: a `role="tree"` sitting in the accessibility
          tree with no way to reach it is worse than one that is not there, and
          the windowing effects have nothing to measure against a pane they do
          not occupy. */}
      {view === "files" && (
        <>
          {!inShell && (
            <input
              className="explorer__filter"
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter"
              aria-label="Filter the loaded folders"
              spellCheck={false}
              autoComplete="off"
            />
          )}

          {/* Outside the tree, not inside it: a `role="tree"` may only contain
          tree items, and an empty tree with a paragraph in it is neither. */}
          {note && <p className={`${note.className} explorer__note`}>{note.text}</p>}

          <div
            ref={scrollRef}
            className="explorer__scroll"
            data-drop-root={(root !== null && dropTarget === root.path) || undefined}
            role="tree"
            aria-label={root ? `${root.name} files` : "Files"}
            // One tab stop for the whole tree. 4,000 rows must not be 4,000 of
            // them, which is the entire reason this is `aria-activedescendant`
            // rather than a roving `tabindex`.
            tabIndex={0}
            // Points at a row that is only in the DOM while it is inside the
            // window. Scrolling far away from the cursor leaves it dangling for as
            // long as that is true — inherent to windowing, and every keyboard
            // move scrolls the row it names back into view.
            aria-activedescendant={cursorIndex >= 0 ? rowId(cursorIndex) : undefined}
            onKeyDown={onKeyDown}
            // The blank space below the last row. A row's own handler stops the
            // event before it gets here, so this only ever fires for a click that
            // hit no row — which is the click that means "the project itself".
            onContextMenu={(event) => {
              if (!root) return;
              event.preventDefault();
              setMenu({
                // Blank space is the project root: a folder, with the folder-level
                // items. `name: null` keeps Rename and Delete off it — the root is
                // the folder the whole tree is anchored on, and `files/root` is the
                // only thing that decides where that is.
                path: root.path,
                createIn: createInFor(null),
                name: null,
                kind: "dir",
                x: event.clientX,
                y: event.clientY,
              });
            }}
          >
            {/* Two spacers standing in for the rows that are not mounted. Plain
            height, so the scrollbar is the size it would have been. */}
            <div style={{ height: port.padTop }} />

            {lines.slice(port.start, port.end).map((line, offset) => {
              const index = port.start + offset;

              if (line.kind === "draft") {
                // Unreachable: the line only exists because `draft` does. Narrowing
                // rather than asserting, so a future change that breaks the pairing
                // renders nothing instead of throwing inside the tree.
                if (!draft) return null;
                return (
                  <DraftRow
                    // Keyed on everything that decides what the field is asking,
                    // so choosing New File and then New Folder in the same place —
                    // or renaming one row and then another — gets a fresh field
                    // rather than one still holding the abandoned answer.
                    key={`draft:${draft.mode}:${draft.path ?? draft.parent}:${draft.kind}`}
                    kind={draft.kind}
                    mode={draft.mode}
                    initialName={draft.initialName}
                    depth={line.depth}
                    id={rowId(index)}
                    indent={INDENT}
                    gutter={GUTTER}
                    busy={creating}
                    onCommit={commitDraft}
                    onCancel={cancelDraft}
                  />
                );
              }

              const { row } = line;
              return (
                <TreeRow
                  key={row.entry.path}
                  row={row}
                  id={rowId(index)}
                  cursor={row.entry.path === cursor}
                  open={row.entry.path === selectedPath}
                  git={git}
                  onActivate={activate}
                  onKeep={keep}
                  drag={rowDrag(row)}
                  dropTarget={
                    dropTarget != null && row.entry.kind === "dir" && row.entry.path === dropTarget
                  }
                  onContextMenu={(target, event) => {
                    event.preventDefault();
                    // Or the scrollport's own handler runs too and replaces this
                    // with the blank-space menu aimed at the root.
                    event.stopPropagation();
                    setCursor(target.entry.path);
                    setMenu({
                      path: target.entry.path,
                      // A folder holds new entries; a file's folder does. Resolved
                      // here rather than in the menu — `row.parent` is the tree's
                      // fact, not a path this app is entitled to work out for
                      // itself — and by the same function File > New File uses, so
                      // the two gestures can never aim at different folders.
                      createIn: createInFor(target),
                      name: target.entry.name,
                      kind: target.entry.kind,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                />
              );
            })}

            <div style={{ height: port.padBottom }} />
          </div>
        </>
      )}

      {menu && root && view === "files" && (
        <ContextMenu
          target={menu}
          rootPath={root.path}
          readOnly={root.readOnly === true}
          onCreate={beginDraft}
          onRename={beginRename}
          onDelete={onDelete}
          onClose={closeMenu}
        />
      )}
    </div>
  );
});

export default Explorer;

/** Index-based rather than path-based: a path is not a legal `id`, and the
 *  flat array's index is what both ends of `aria-activedescendant` have. */
const rowId = (index: number) => `explorer-row-${index}`;

/**
 * What to say when the tree draws nothing, and nothing while it draws rows.
 *
 * The filtered case is deliberately not "no results". The tree is lazy, so a
 * folder nobody has opened has nothing to match against; saying anything
 * shorter would be claiming a whole-project search, which means a recursive
 * `files/search` this app does not have yet.
 */
function emptyNote(
  rootError: string | null,
  ready: boolean,
  rowCount: number,
  filter: string,
): { className: string; text: string } | null {
  if (rootError) return { className: "app__error", text: rootError };
  if (rowCount > 0 || !ready) return null;
  if (filter.trim()) {
    return { className: "app__note", text: "No match in the folders loaded so far." };
  }
  return { className: "app__note", text: "This folder is empty." };
}

/**
 * Toggle to the deleted list.
 *
 * Tabler's outline "trash" at 2px in a 24×24 box, authored here for the same
 * reason as the chevron and the refresh arrows: `src/ui/Icon.tsx` is the
 * shell's, and an app may not reach into `src/`.
 */
function Bin() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
    </svg>
  );
}

/**
 * Re-read the open folders.
 *
 * Tabler's outline "refresh" at 2px in a 24×24 box, per the rule in
 * `src/ui/Icon.tsx` for a glyph the handoff never drew. Authored here rather
 * than imported for the reason given on `TreeRow.tsx`'s chevron: an app does
 * not reach into `src/`.
 */
function Refresh() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 5v4h4" />
      <path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 19v-4h-4" />
    </svg>
  );
}
