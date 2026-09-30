/**
 * One pane's own tab strip — KAAVA-UX-SPEC.md §1.6: `34px`, a file-type
 * colour square or app icon, the label, and a close button on hover; the
 * active tab carries a 2px accent underline.
 *
 * This is the thing `PaneTree.tsx`'s own header used to say was gone for
 * good, and the reason it is back is written there, not here: the v3 boards
 * (board 07 in particular) draw a strip on every pane, and the `chrome`
 * workstream is pulling the equivalent listing out of `ClusterBar` in the
 * same change, so a tab still appears in exactly one row — it has just moved.
 * `docs/design-notes/shell-chrome.md` has the older argument for why a tab in
 * two rows is a tab that can disagree with itself; nothing about that
 * argument has stopped being true, only which row won.
 */
import { AppWindow, Terminal } from "lucide-react";
import type { ClusterMember, DragHandleProps, PaneAppPicker } from "../contract";
import { useDropZone } from "../dropZones";
import { fileIconUrl } from "@openkaava/file-icons";
import { getSubject, subjectsVersion, subscribeSubjects } from "../viewerSubjects";
import { Close } from "../../ui/Icon";
import { useRef, useState, useSyncExternalStore } from "react";
import { Plus } from "../../ui/Icon";
import AppPicker from "./AppPicker";

export default function PaneTabStrip({
  paneId,
  members,
  caret,
  onSelect,
  onClose,
  onToggleMaximize,
  dragHandleFor,
  appPicker,
}: {
  paneId: string;
  /** This pane's own tabs, in layout order — already filtered by the caller. */
  members: ClusterMember[];
  /** The insertion index a drag in the air would land at, or `null` when the
   *  drag is aimed elsewhere. Counted over this strip's own tabs, matching
   *  what `dropZones.ts`'s `strip` zone measures below. */
  caret: number | null;
  onSelect: (member: ClusterMember) => void;
  onClose: (member: ClusterMember) => void;
  /** Double-click a tab: maximise this pane, or restore it if it already is. */
  onToggleMaximize: (paneId: string) => void;
  dragHandleFor?: (member: ClusterMember) => DragHandleProps | undefined;
  /** The list behind the trailing `+`. Omitted, the strip has no `+`. */
  appPicker?: PaneAppPicker;
}) {
  const tabRefs = useRef<Map<string, HTMLElement>>(new Map());

  // The strip's own drop zone, scoped to exactly this pane's tabs — unlike
  // `ClusterBar`'s old row-wide zone, there is only ever one pane's worth of
  // tabs to measure here, so `at` ignores `x` for anything but the caret math.
  const stripZone = useDropZone({
    kind: "strip",
    at: () => ({
      paneId,
      tabRects: members.map(
        (m) => tabRefs.current.get(m.id)?.getBoundingClientRect() ?? new DOMRect(),
      ),
    }),
  });

  return (
    <div className="pane-tabstrip" ref={stripZone} data-pane-strip={paneId}>
      {members.map((member, i) => (
        <PaneTab
          key={member.id}
          member={member}
          caretBefore={caret === i}
          onSelect={onSelect}
          onClose={onClose}
          onToggleMaximize={() => onToggleMaximize(paneId)}
          dragHandle={dragHandleFor?.(member)}
          tabRef={(el) => {
            if (el) tabRefs.current.set(member.id, el);
            else tabRefs.current.delete(member.id);
          }}
        />
      ))}
      {caret === members.length && <span className="pane-tabstrip__caret" />}
      {appPicker && <AddAppTab paneId={paneId} picker={appPicker} />}
    </div>
  );
}

/**
 * The `+` at the end of a pane's tabs: opens the app picker, and the chosen app
 * becomes a new tab in this pane. Distinct from the cluster switcher's `+`, which
 * makes a whole cluster — the label says which one this is.
 */
function AddAppTab({ paneId, picker }: { paneId: string; picker: PaneAppPicker }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="pane-tabstrip__add"
        data-open={at !== null || undefined}
        aria-haspopup="dialog"
        aria-expanded={at !== null}
        aria-label="Open an app in this pane"
        title="Open an app in this pane"
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect();
          if (rect) setAt({ top: rect.bottom + 2, left: rect.left });
        }}
        // A press here must not start a tab drag or refocus through the strip.
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Plus size={13} />
      </button>
      {at !== null && (
        <AppPicker
          apps={picker.apps}
          blocked={picker.blocked}
          anchor={at}
          onPick={(entry) => picker.onOpen(entry, paneId)}
          onClose={() => setAt(null)}
        />
      )}
    </>
  );
}

function PaneTab({
  member,
  caretBefore,
  onSelect,
  onClose,
  onToggleMaximize,
  dragHandle,
  tabRef,
}: {
  member: ClusterMember;
  caretBefore: boolean;
  onSelect: (member: ClusterMember) => void;
  onClose: (member: ClusterMember) => void;
  onToggleMaximize: () => void;
  dragHandle?: DragHandleProps;
  tabRef: (el: HTMLElement | null) => void;
}) {
  const classes = ["pane-tab"];
  if (member.showing) classes.push("pane-tab--active");

  // A File Viewer is one file: its tab is named for it, wears its icon, and
  // says where it is and whether it has unsaved edits. Re-read when the shell
  // learns something new about a viewer.
  useSyncExternalStore(subscribeSubjects, subjectsVersion);
  const file = member.appId === "viewer" ? getSubject(member.id) : undefined;

  return (
    <>
      {caretBefore && <span className="pane-tabstrip__caret" />}
      <div
        ref={tabRef}
        role="tab"
        aria-selected={member.showing}
        tabIndex={0}
        className={classes.join(" ")}
        title={file ? file.path : member.title}
        onClick={() => onSelect(member)}
        onDoubleClick={onToggleMaximize}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(member);
          }
        }}
        // Middle-click closes, same as a browser tab. `auxclick` rather than
        // `mousedown`/`mouseup`, which would also catch the press that starts
        // a drag on some pointing devices — `auxclick` fires only once a
        // button other than the primary one both went down and came back up
        // over this element.
        onAuxClick={(e) => {
          if (e.button === 1) onClose(member);
        }}
        onPointerDown={dragHandle?.onPointerDown}
        style={dragHandle?.style}
      >
        {member.kind === "terminal" ? (
          <Terminal size={16} strokeWidth={1.5} className="pane-tab__icon" aria-hidden="true" />
        ) : (
          <>
            {file ? (
              <img
                className="pane-tab__fileicon"
                src={fileIconUrl(member.title)}
                alt=""
                width={14}
                height={14}
                draggable={false}
              />
            ) : (
              <AppWindow
                size={14}
                strokeWidth={1.5}
                className="pane-tab__icon pane-tab__icon--app"
                aria-hidden="true"
              />
            )}
          </>
        )}

        <span className="pane-tab__label">{member.title}</span>

        {/* Same one-box, two-occupant trade `switcher.css`'s member tab
            makes: the agent-finished dot normally, the close button on
            hover or keyboard focus, never both, so the tab's width does not
            change under the pointer. There is no modified-file dot here —
            nothing in `ClusterMember`/`SurfaceInstance` tracks a dirty
            state, and drawing one from nothing is exactly what the rework
            brief's "never fake data" rule forbids. A File Viewer is the one
            exception, because it reports its own (`viewerSubjects`). */}
        <span className="pane-tab__end">
          {member.agentFinished && <span className="pane-tab__dot" />}
          {file?.dirty && (
            <span className="pane-tab__dot pane-tab__dot--dirty" title="Unsaved changes" />
          )}
          <button
            type="button"
            className="pane-tab__close"
            aria-label={`Close ${member.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose(member);
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Close />
          </button>
        </span>
      </div>
    </>
  );
}
