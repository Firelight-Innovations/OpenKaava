/**
 * The open files, drawn as tabs.
 *
 * Almost every decision here is `useOpenFiles`'s — which tabs exist, which is
 * active, which are dirty, what a close does about unsaved work. What this file
 * owns is the visual language, and that is not its own invention: the shell
 * already draws tabs in `src/shell/switcher/ToolSwitcherBar.tsx`, and a second
 * tab look inside the same window would read as a second product. Active tab is
 * `--bg` against the strip's `--surface`, with a 2px `--accent` rule along its
 * top edge, exactly as `.switcher__tab--active` and `.switcher__rule` do it.
 *
 * No framer-motion. The shell's rule slides between tool tabs because those
 * tabs are the top-level navigation of the whole window; a file tab strip is a
 * list that changes length as you work, and animating it would draw the eye to
 * the least interesting thing on screen. Same rule as the tree.
 *
 * What this deliberately does not do: shrink. Tabs keep their width and the
 * strip scrolls, because a row of tabs squeezed to eight pixels each is a row
 * of tabs you cannot read or hit.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { dragContext } from "../../../../shared/context";
import { putFile, relativePath } from "../../../../shared/fileContext";
import ContextMenu, { type MenuTarget } from "../ContextMenu";
import NoticeBar from "../NoticeBar";
import { describe, rename } from "../rpc";
import type { DeleteTarget } from "../useDelete";
import { useInlineName } from "../useInlineName";
import type { OpenTab } from "./useOpenFiles";
import "./tabs.css";

export interface TabStripProps {
  tabs: OpenTab[];
  activePath: string | null;
  dirty: ReadonlySet<string>;
  /** What "relative" is relative to, for the menu's copy items. */
  rootPath: string | null;
  /**
   * Show this tab. `promote` rides along rather than arriving as another prop,
   * and not only to keep the count down: double-clicking a preview tab *is* an
   * activation — the one that says "stop offering to replace this" — so the two
   * facts belong to one call.
   */
  onActivate(path: string, promote?: boolean): void;
  onClose(path: string): void;
  /** A rename landed on disk. Only the tab model can act on it. */
  onRenamed(from: string, to: string): void;
  /** Ask whether to delete this tab's file. One confirmation owns the app. */
  onDelete(target: DeleteTarget): void;
}

export default function TabStrip({
  tabs,
  activePath,
  dirty,
  rootPath,
  onActivate,
  onClose,
  onRenamed,
  onDelete,
}: TabStripProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  /**
   * The two pieces of state this strip holds of its own: **which chip was
   * right-clicked**, and below it **which chip is being renamed in place**.
   * Neither means anything to anyone else — a menu is open until it is
   * dismissed, and a half-typed name belongs to the field it is being typed
   * into. Everything a rename *changes* still goes out through `onRenamed` to
   * the tab model, which is the only thing allowed to move a buffer.
   */
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  /** The tab being renamed in place, by path. At most one. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  /**
   * Keep the active tab on screen.
   *
   * Needed because activation has three sources — a click here, a click in the
   * tree, and a close moving to a neighbour — and only the first of them is
   * guaranteed to be somewhere the user can already see.
   */
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || activePath === null) return;
    const index = tabs.findIndex((tab) => tab.path === activePath);
    const element = strip.children[index];
    if (element instanceof HTMLElement) {
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activePath, tabs]);

  /**
   * Abandon a rename whose tab has gone.
   *
   * Closing the file being renamed is the reachable case. Leaving the state set
   * would strand a `renaming` path with no chip rendering it, and the field
   * would reappear — empty — if a tab for that path were ever opened again.
   */
  const orphaned = renaming !== null && !tabs.some((tab) => tab.path === renaming);
  useEffect(() => {
    if (orphaned) {
      setRenaming(null);
      setRenameError(null);
      setRenameBusy(false);
    }
  }, [orphaned]);

  const commitRename = (path: string, name: string) => {
    setRenameBusy(true);
    setRenameError(null);

    void rename(path, name)
      .then((entry) => {
        setRenaming(null);
        setRenameBusy(false);
        onRenamed(path, entry.path);
      })
      .catch((err: unknown) => {
        // The field stays exactly where it is with the name still in it: the
        // common failure is a name that is taken or a character Windows will
        // not store, and both are fixed by editing what was just typed.
        setRenameBusy(false);
        setRenameError(describe("files/rename", err));
      });
  };

  const closeMenu = () => setMenu(null);

  return (
    <div className="tabs">
      <div className="tabs__strip" role="tablist" aria-label="Open files" ref={stripRef}>
        {tabs.map((tab, index) => (
          <Tab
            key={tab.path}
            tab={tab}
            index={index}
            tabs={tabs}
            active={tab.path === activePath}
            dirty={dirty.has(tab.path)}
            rootPath={rootPath}
            renaming={renaming === tab.path}
            renameBusy={renameBusy}
            onActivate={onActivate}
            onClose={onClose}
            onCommitRename={(name) => commitRename(tab.path, name)}
            onCancelRename={() => {
              setRenaming(null);
              setRenameError(null);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({
                path: tab.path,
                // A tab is a file that is open, not a place — see `createIn`.
                createIn: null,
                // A file already gone from disk has nothing there to rename or
                // to delete, so both items drop out together.
                name: tab.missing ? null : tab.name,
                // A tab is always a file; a folder is not something this app
                // can open into one.
                kind: "file",
                x: event.clientX,
                y: event.clientY,
              });
            }}
          />
        ))}
      </div>

      {renameError && (
        <NoticeBar
          notice={{
            tone: "err",
            message: renameError,
            actions: [{ label: "Dismiss", run: () => setRenameError(null) }],
          }}
        />
      )}

      {tabs.map((tab) => (tab.notice ? <NoticeBar key={tab.path} notice={tab.notice} /> : null))}

      {menu && (
        <ContextMenu
          target={menu}
          rootPath={rootPath ?? ""}
          // Unreachable: a tab menu sets `createIn` to null, so the two create
          // items are not drawn and this cannot be called.
          onCreate={() => {}}
          onRename={(path) => setRenaming(path)}
          onDelete={onDelete}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}

interface TabProps {
  tab: OpenTab;
  index: number;
  tabs: OpenTab[];
  active: boolean;
  dirty: boolean;
  rootPath: string | null;
  renaming: boolean;
  renameBusy: boolean;
  onActivate(path: string, promote?: boolean): void;
  onClose(path: string): void;
  onCommitRename(name: string): void;
  onCancelRename(): void;
  onContextMenu(event: React.MouseEvent): void;
}

/**
 * A `div[role=tab]` rather than a `<button>`, because the close affordance is a
 * button and a button inside a button is not valid HTML — browsers reparent it
 * and the click lands somewhere nobody predicted.
 */
function Tab({
  tab,
  index,
  tabs,
  active,
  dirty,
  rootPath,
  renaming,
  renameBusy,
  onActivate,
  onClose,
  onCommitRename,
  onCancelRename,
  onContextMenu,
}: TabProps) {
  const classes = ["tabs__tab"];
  if (active) classes.push("tabs__tab--active");
  if (dirty) classes.push("tabs__tab--dirty");
  if (tab.missing) classes.push("tabs__tab--missing");
  if (tab.preview) classes.push("tabs__tab--preview");
  if (renaming) classes.push("tabs__tab--renaming");

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate(tab.path);
      return;
    }

    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const target = index + (event.key === "ArrowLeft" ? -1 : 1);
    const next = tabs[target];
    if (!next) return;
    event.preventDefault();
    onActivate(next.path);
    // The strip's children are the tabs, in order, so the sibling at the new
    // index is the element to focus. Roving `tabIndex` alone decides where Tab
    // lands next; it does not move focus now.
    const sibling = event.currentTarget.parentElement?.children[target];
    if (sibling instanceof HTMLElement) sibling.focus();
  };

  return (
    <div
      className={classes.join(" ")}
      role="tab"
      aria-selected={active}
      // Roving tabindex: one stop for the whole strip, arrows to move within it.
      // Taken away while renaming, so Tab leaves the field rather than landing
      // back on the chip that contains it.
      tabIndex={renaming ? -1 : active ? 0 : -1}
      title={tab.missing ? `${tab.path} — no longer on disk` : tab.path}
      onClick={renaming ? undefined : () => onActivate(tab.path)}
      // Double-clicking a tab keeps it. The single clicks underneath it have
      // already activated the tab, so this only ever adds the promotion — and
      // on a tab that was never a preview it is a no-op, which is why it is not
      // guarded on `tab.preview`.
      onDoubleClick={renaming ? undefined : () => onActivate(tab.path, true)}
      onKeyDown={renaming ? undefined : onKeyDown}
      onContextMenu={onContextMenu}
      // Press and drag onto a terminal to hand the agent this file. The file on
      // disk is what is sent, so a tab with unsaved edits or none on disk is
      // not draggable: it would send something other than what the tab shows.
      onPointerDown={
        renaming || dirty || tab.missing
          ? undefined
          : dragContext(() => putFile(tab.path, relativePath(rootPath, tab.path)))
      }
      // Middle-click closes. `onMouseDown` too, because button 1 starts
      // autoscroll on Windows and leaves the page under a scroll cursor.
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1 || renaming) return;
        event.preventDefault();
        onClose(tab.path);
      }}
    >
      {renaming ? (
        <TabRenameField
          initial={tab.name}
          busy={renameBusy}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      ) : (
        <>
          <span className="tabs__name">{tab.name}</span>

          {/* One fixed slot holding both marks, so the tab does not change
              width when the dot gives way to the close button on hover. */}
          <span className="tabs__slot">
            <span className="tabs__dot" aria-hidden="true" />
            <button
              type="button"
              className="tabs__close"
              aria-label={`Close ${tab.name}`}
              onClick={(event) => {
                // Or the click also activates the tab that is about to
                // disappear.
                event.stopPropagation();
                onClose(tab.path);
              }}
            >
              ×
            </button>
          </span>
        </>
      )}
    </div>
  );
}

/**
 * Renaming a file from its own tab.
 *
 * The field replaces the label in the chip it belongs to, for the same reason
 * the tree's version replaces the row: the answer belongs where the question
 * was asked. Its behaviour is `useInlineName` — the tree's, exactly — so Enter,
 * Escape, click-away, the empty answer and the unchanged answer all behave
 * identically in both places, described once. Only the markup differs, and it
 * has to: a tree row and a tab chip are not the same shape.
 */
function TabRenameField({
  initial,
  busy,
  onCommit,
  onCancel,
}: {
  initial: string;
  busy: boolean;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const field = useInlineName({ initial, mode: "rename", busy, onCommit, onCancel });

  return (
    <input
      ref={field.inputRef}
      className="tabs__rename"
      value={field.value}
      disabled={busy}
      onChange={(event) => field.setValue(event.target.value)}
      onKeyDown={field.onKeyDown}
      onBlur={field.onBlur}
      aria-label={`New name for ${initial}`}
      spellCheck={false}
      autoComplete="off"
      // The chip's own click handlers are off while this is up, but the field
      // still sits inside a `role="tab"` — so a click in the text must not be
      // read as a click on the tab behind it.
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      // A right-click inside the field is the browser's own edit menu, which is
      // the right menu here — not this app's, over the field being typed in.
      onContextMenu={(event) => event.stopPropagation()}
    />
  );
}
