import { useState, useSyncExternalStore } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
  File as FileIcon,
  CornerDownLeft,
  X,
  Image,
} from "lucide-react";
import {
  contextRemove,
  terminalSetHarness,
  type AgentSeen,
  type ContextItem,
  type Harness,
} from "../../bindings";
import { HARNESS_LABEL, insertItems } from "../contextInput";
import { noticeFor, subscribe } from "../terminalNotice";
import type { StripLayout } from "./contextLayout";
import { useAgentSaw, useSeenThumb } from "./useAgentSaw";
import { useContextItems, useHarnessInfo, useThumb } from "./useContextItems";
import "./contextStrip.css";

const COLLAPSED_KEY = "kaava.contextStrip.collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    // Storage can be blocked; the strip just forgets on reload.
  }
}

/** `1.2 MB`, `340 KB`, `12 B`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The one-line detail under a chip's title. */
export function itemMeta(item: ContextItem): string {
  if (item.missing) return "File missing";
  const parts: string[] = [];
  if (item.image) parts.push(`${item.image.width} × ${item.image.height}`);
  if (item.text) parts.push(`${item.text.lines} ${item.text.lines === 1 ? "line" : "lines"}`);
  parts.push(formatSize(item.size));
  return parts.join(" · ");
}

/**
 * The Context strip: what has been put in front of the agent in this
 * environment, beside the terminal it will be read in.
 *
 * Hidden when there is nothing to show, so a person who never uses it sees no
 * change. Collapsible to a thin bar that keeps the count, and that choice is
 * remembered.
 */
export default function ContextStrip({
  sessionId,
  layout = "side",
}: {
  sessionId: string;
  /** `side` is the column beside the terminal; `bottom` is the horizontal band
   *  under it, for a tall narrow pane. Same actions either way. */
  layout?: StripLayout;
}) {
  const bottom = layout === "bottom";
  const items = useContextItems(sessionId);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const saw = useAgentSaw(sessionId);
  const [asking, setAsking] = useState(false);
  const { info, refresh } = useHarnessInfo(sessionId, items.length);
  const count = items.length + saw.seen.length;

  if (count === 0) return null;

  const toggle = () => {
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });
  };

  if (collapsed) {
    return (
      <aside className={`ctxstrip ctxstrip--${layout} ctxstrip--collapsed`} aria-label="Context">
        <button
          type="button"
          className="ctxstrip__expand"
          onClick={toggle}
          aria-label={`Show context, ${count} ${count === 1 ? "item" : "items"}`}
          aria-expanded={false}
        >
          <Image size={14} strokeWidth={1.5} aria-hidden />
          {bottom && <span className="ctxstrip__title">Context</span>}
          <span className="ctxstrip__count">{count}</span>
          {bottom && <ChevronUp size={14} strokeWidth={1.5} aria-hidden />}
        </button>
      </aside>
    );
  }

  const value: Harness | "auto" = info?.overridden ?? "auto";
  const autoLabel = info?.detected ? HARNESS_LABEL[info.detected] : "plain shell";

  const target = (
    <label className="ctxstrip__target">
      <span>Insert as</span>
      <select
        value={value}
        onChange={(e) => {
          void terminalSetHarness(sessionId, e.target.value as Harness | "auto").then(refresh);
        }}
      >
        <option value="auto">Auto ({autoLabel})</option>
        <option value="claude">Claude Code</option>
        <option value="codex">Codex</option>
        <option value="gemini">Gemini</option>
        <option value="shell">Plain shell</option>
      </select>
    </label>
  );

  // In the band the plain "Show images the agent reads" link rides in the
  // header row to save a row of height; the consent text and any error still
  // need room, so they take their own row below the cards.
  const footInHeader = bottom && !asking && !saw.error;
  const foot = (
    <footer className="ctxstrip__foot">
      {saw.status?.installed ? (
        <button type="button" className="ctxstrip__link" onClick={() => void saw.disable()}>
          Stop tracking what the agent reads
        </button>
      ) : asking ? (
        <div className="ctxstrip__consent" role="group" aria-label="Track what the agent reads">
          <p>
            Kaava will add a hook to{" "}
            <code>{saw.status?.settingsPath ?? ".claude/settings.local.json"}</code> that records
            the path of each file Claude Code reads, so images it looked at show here. Your other
            settings are kept. Nothing leaves this machine, and you can remove it here at any time.
          </p>
          <div className="ctxstrip__consent-actions">
            <button
              type="button"
              className="ctxstrip__link"
              onClick={() => void saw.enable().then(() => setAsking(false))}
            >
              Add hook
            </button>
            <button type="button" className="ctxstrip__link" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="ctxstrip__link" onClick={() => setAsking(true)}>
          Show images the agent reads…
        </button>
      )}
      {saw.error && (
        <p className="ctxstrip__error" role="alert">
          {saw.error}
        </p>
      )}
    </footer>
  );

  return (
    <aside className={`ctxstrip ctxstrip--${layout}`} aria-label="Context" onPointerEnter={refresh}>
      <header className="ctxstrip__head">
        <span className="ctxstrip__title">Context</span>
        <span className="ctxstrip__total">{count}</span>
        {bottom && target}
        {footInHeader && foot}
        <button
          type="button"
          className="ctxstrip__icon"
          onClick={toggle}
          aria-label="Hide context"
          aria-expanded
        >
          {bottom ? (
            <ChevronDown size={14} strokeWidth={1.5} aria-hidden />
          ) : (
            <ChevronRight size={14} strokeWidth={1.5} aria-hidden />
          )}
        </button>
      </header>

      {!bottom && target}

      <div className="ctxstrip__scroll">
        {items.length > 0 && (
          <ul className="ctxstrip__list">
            {items.map((item) => (
              <Chip key={item.id} sessionId={sessionId} item={item} />
            ))}
          </ul>
        )}
        {saw.seen.length > 0 && (
          <section aria-label="Agent saw">
            <h3 className="ctxstrip__section">Agent saw</h3>
            <ul className="ctxstrip__list">
              {saw.seen.map((seen) => (
                <SeenChip key={seen.path} sessionId={sessionId} seen={seen} />
              ))}
            </ul>
          </section>
        )}
      </div>

      {!footInHeader && foot}
    </aside>
  );
}

function Chip({ sessionId, item }: { sessionId: string; item: ContextItem }) {
  const thumb = useThumb(sessionId, item);
  return (
    <li className="ctxchip" data-missing={item.missing || undefined}>
      <div className="ctxchip__thumb" aria-hidden>
        {thumb ? (
          <img src={thumb} alt="" draggable={false} />
        ) : item.kind === "text" ? (
          <FileText size={16} strokeWidth={1.5} />
        ) : item.kind === "file" ? (
          <FileIcon size={16} strokeWidth={1.5} />
        ) : (
          <Image size={16} strokeWidth={1.5} />
        )}
      </div>
      <div className="ctxchip__body">
        <span className="ctxchip__title" title={item.path}>
          {item.title}
        </span>
        <span className="ctxchip__meta">{itemMeta(item)}</span>
      </div>
      <div className="ctxchip__actions">
        <button
          type="button"
          className="ctxstrip__icon"
          disabled={item.missing}
          aria-label={`Insert ${item.title} at the prompt`}
          title="Insert at the prompt"
          onClick={() => void insertItems(sessionId, [item.id])}
        >
          <CornerDownLeft size={14} strokeWidth={1.5} aria-hidden />
        </button>
        <button
          type="button"
          className="ctxstrip__icon"
          aria-label={`Remove ${item.title}`}
          title={item.owned ? "Remove and delete the stored copy" : "Remove from the list"}
          onClick={() => void contextRemove(sessionId, item.id)}
        >
          <X size={14} strokeWidth={1.5} aria-hidden />
        </button>
      </div>
    </li>
  );
}

function SeenChip({ sessionId, seen }: { sessionId: string; seen: AgentSeen }) {
  const thumb = useSeenThumb(sessionId, seen);
  return (
    <li className="ctxchip" data-missing={seen.missing || undefined}>
      <div className="ctxchip__thumb" aria-hidden>
        {thumb ? (
          <img src={thumb} alt="" draggable={false} />
        ) : (
          <Image size={16} strokeWidth={1.5} />
        )}
      </div>
      <div className="ctxchip__body">
        <span className="ctxchip__title" title={seen.path}>
          {seen.name}
        </span>
        <span className="ctxchip__meta">{seen.missing ? "File missing" : "Read by the agent"}</span>
      </div>
    </li>
  );
}

/** The "Inserted 2 references for Claude Code" line, over the terminal's own
 *  lower edge. Drawn here rather than in `XTermView` so the emulator stays a
 *  pure view of a pty. */
export function ContextNotice({ sessionId }: { sessionId: string }) {
  const notice = useSyncExternalStore(
    subscribe,
    () => noticeFor(sessionId),
    () => undefined,
  );
  if (!notice) return null;
  return (
    <div
      className="ctxnotice"
      data-error={notice.error || undefined}
      role={notice.error ? "alert" : "status"}
      key={notice.seq}
    >
      {notice.text}
    </div>
  );
}
