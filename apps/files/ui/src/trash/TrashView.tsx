/**
 * What this project has deleted, and the way back.
 *
 * Sits in the explorer pane in place of the tree. Same pane, same visual
 * language — rows, the same icons, the same hover — because it is the same kind
 * of thing: a list of files you can act on. What it is not is a second file
 * browser, so there is no expanding, no filter and no keyboard tree: every item
 * here is flat by nature, since a deleted folder is one item and not a subtree
 * you can walk.
 */
import { useCallback, useEffect, useState } from "react";
import { PRODUCT_NAME } from "../branding.generated";
import NoticeBar, { type Notice } from "../NoticeBar";
import { fileIconUrl, folderIconUrl } from "@veistra/file-icons";
import {
  describe,
  formatSize,
  trashList,
  trashPurge,
  trashRestore,
  type Root,
  type TrashItem,
} from "../rpc";
import "./trash.css";

export default function TrashView({
  root,
  /** A change means "read the bin again". */
  reloadNonce,
  onRestored,
}: {
  root: Root | null;
  reloadNonce: number;
  /** Something came back to disk, so the tree beside this is now out of date. */
  onRestored: () => void;
}) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * When the snapshot below was taken.
   *
   * The Recycle Bin changes outside this app — the user can empty it from
   * Explorer, restore something from there, or delete a file with any other
   * program. So this list is a *snapshot*, and it says when it was taken rather
   * than pretending to be live. It re-reads whenever the view is opened,
   * whenever the refresh button is pressed, and after any action taken here.
   * There is no watcher and no poll, for the same reason `useOpenFiles` has
   * neither.
   *
   * The honest consequence: an item can disappear between the list and the
   * click. The backend answers that with "not in this project's Recycle Bin —
   * it may have been restored, purged, or emptied since the list was read",
   * which is shown as it arrives.
   */
  const [readAt, setReadAt] = useState<number | null>(null);
  /** The item a purge is being confirmed for. At most one. */
  const [purging, setPurging] = useState<TrashItem | null>(null);
  /** An id with a call out, so its row can say so and stop taking clicks. */
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * Read the bin. It only ever shows this project: `trash/list` is scoped in
   * the backend to items whose original location was inside the project root,
   * and restore and purge look their id up in that same scoped set. That
   * matters more than it sounds — the system Recycle Bin holds everything the
   * user has ever deleted anywhere, and showing it raw would put their personal
   * files inside a game editor. Nothing in this file widens that; it renders
   * what it is given. See `src-tauri/src/apps/trash.rs`.
   */
  const read = useCallback(() => {
    setError(null);
    void trashList()
      .then((listing) => {
        setItems(listing.items);
        setReadAt(Date.now());
      })
      .catch((err: unknown) => {
        // The list failing is worth showing rather than rendering as empty: an
        // empty bin and an unreadable one are opposite facts, and only one of
        // them means "nothing to recover".
        setItems(null);
        setError(describe("trash/list", err));
      });
  }, []);

  useEffect(read, [read, reloadNonce, root]);

  const restore = (item: TrashItem) => {
    setBusy(item.id);
    setError(null);
    void trashRestore(item.id)
      .then(() => {
        onRestored();
        read();
      })
      .catch((err: unknown) => setError(describe("trash/restore", err)))
      .finally(() => setBusy(null));
  };

  const purge = (item: TrashItem) => {
    setBusy(item.id);
    setError(null);
    void trashPurge(item.id)
      .then(() => {
        setPurging(null);
        read();
      })
      .catch((err: unknown) => {
        setPurging(null);
        setError(describe("trash/purge", err));
      })
      .finally(() => setBusy(null));
  };

  /**
   * The purge confirmation.
   *
   * Worded harder than the delete one on purpose. A delete is answered by this
   * very view; a purge is answered by nothing at all, and it is the only action
   * in the app with no recovery path — so the copy says that in as many words
   * rather than relying on the word "permanently" carrying it.
   */
  const notice: Notice | null = purging && {
    tone: "err",
    message: `Permanently delete ${purging.name}? This cannot be undone — it will not go back to the Recycle Bin, and nothing in ${PRODUCT_NAME} or Windows will be able to recover it.`,
    actions: [
      { label: "Cancel", run: () => setPurging(null) },
      {
        label: busy === purging.id ? "Deleting…" : "Delete permanently",
        danger: true,
        run: () => {
          if (busy !== purging.id) purge(purging);
        },
      },
    ],
  };

  return (
    <div className="trash">
      {error && (
        <NoticeBar
          notice={{
            tone: "err",
            message: error,
            actions: [{ label: "Dismiss", run: () => setError(null) }],
          }}
        />
      )}

      {items === null && !error && (
        <p className="app__note trash__note">Reading the Recycle Bin…</p>
      )}

      {items !== null && items.length === 0 && (
        <p className="app__note trash__note">
          Nothing deleted from this project is in the Recycle Bin.
        </p>
      )}

      {items !== null && items.length > 0 && (
        <div className="trash__list" role="list">
          {items.map((item) => (
            <TrashRow
              key={item.id}
              item={item}
              rootPath={root?.path ?? ""}
              busy={busy === item.id}
              onRestore={() => restore(item)}
              onPurge={() => setPurging(item)}
            />
          ))}
        </div>
      )}

      {/* Said last and quietly: it is a caveat about the list above, not news.
          Without it the pane would be claiming to be live, which it is not. */}
      {readAt !== null && items !== null && (
        <p className="app__note trash__stamp">Read {clockTime(readAt)}. Refresh to re-check.</p>
      )}

      {notice && <NoticeBar notice={notice} onEscape={() => setPurging(null)} />}
    </div>
  );
}

function TrashRow({
  item,
  rootPath,
  busy,
  onRestore,
  onPurge,
}: {
  item: TrashItem;
  rootPath: string;
  busy: boolean;
  onRestore: () => void;
  onPurge: () => void;
}) {
  // A directory reports its child count and no byte size; a file the reverse.
  // Both null means the backend could not measure it, which is a thing that can
  // happen to a real item and is not worth refusing to draw over — it is shown
  // as a file, which is the commoner case and costs only the icon.
  const isDir = item.entries !== null;

  return (
    <div className="trash__row" role="listitem">
      <img
        className="trash__icon"
        src={isDir ? folderIconUrl(item.name, false) : fileIconUrl(item.name)}
        alt=""
        draggable={false}
      />

      <span className="trash__body">
        <span className="trash__name">{item.name}</span>
        {/* Where it came from, relative to the project — the absolute path is
            mostly the project root repeated on every row. The full one is on
            the row's tooltip for when it is actually wanted. */}
        <span className="trash__where" title={item.originalPath}>
          {relativeTo(rootPath, item.originalParent) || "the project root"}
          {" · "}
          {describeSize(item)}
          {" · "}
          {agoFrom(item.deletedUnixMs)}
        </span>
      </span>

      <span className="trash__actions">
        <button
          type="button"
          className="trash__action"
          disabled={busy}
          onClick={onRestore}
          title={`Put ${item.name} back in ${item.originalParent}`}
        >
          Restore
        </button>
        <button
          type="button"
          className="trash__action trash__action--danger"
          disabled={busy}
          onClick={onPurge}
          title={`Permanently delete ${item.name}`}
        >
          Delete
        </button>
      </span>
    </div>
  );
}

/** Bytes for a file, a child count for a folder, and nothing when unmeasured. */
function describeSize(item: TrashItem): string {
  if (item.size !== null) return formatSize(item.size);
  if (item.entries !== null) {
    return item.entries === 1 ? "1 item" : `${item.entries} items`;
  }
  return "size unknown";
}

/**
 * How long ago, in the coarsest unit that is still true.
 *
 * Coarse on purpose: the useful question about a deleted file is "was this just
 * now, or was it last week", and a timestamp to the second invites reading a
 * precision that a Recycle Bin's own bookkeeping does not really carry.
 */
function agoFrom(unixMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - unixMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** Wall-clock time, for the snapshot stamp. Local, and to the minute. */
function clockTime(unixMs: number): string {
  return new Date(unixMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The path as written from the project root.
 *
 * The same prefix strip `ContextMenu` uses, and here for the same reason: both
 * strings came out of one backend on one machine, so the root really is a
 * textual prefix. A path that somehow is not under it is shown whole rather than
 * mangled into something plausible-looking.
 */
function relativeTo(rootPath: string, path: string): string {
  if (!rootPath || !path.startsWith(rootPath)) return path;
  return path.slice(rootPath.length).replace(/^[\\/]+/, "");
}
