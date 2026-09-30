import { useState, useSyncExternalStore } from "react";
import { ChevronRight, FileText, File as FileIcon, CornerDownLeft, X, Image } from "lucide-react";
import { contextRemove, terminalSetHarness, type ContextItem, type Harness } from "../../bindings";
import { HARNESS_LABEL, insertItems } from "../contextInput";
import { noticeFor, subscribe } from "../terminalNotice";
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
export default function ContextStrip({ sessionId }: { sessionId: string }) {
  const items = useContextItems(sessionId);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const { info, refresh } = useHarnessInfo(sessionId, items.length);

  if (items.length === 0) return null;

  const toggle = () => {
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });
  };

  if (collapsed) {
    return (
      <aside className="ctxstrip ctxstrip--collapsed" aria-label="Context">
        <button
          type="button"
          className="ctxstrip__expand"
          onClick={toggle}
          aria-label={`Show context, ${items.length} ${items.length === 1 ? "item" : "items"}`}
          aria-expanded={false}
        >
          <Image size={14} strokeWidth={1.5} aria-hidden />
          <span className="ctxstrip__count">{items.length}</span>
        </button>
      </aside>
    );
  }

  const value: Harness | "auto" = info?.overridden ?? "auto";
  const autoLabel = info?.detected ? HARNESS_LABEL[info.detected] : "plain shell";

  return (
    <aside className="ctxstrip" aria-label="Context" onPointerEnter={refresh}>
      <header className="ctxstrip__head">
        <span className="ctxstrip__title">Context</span>
        <span className="ctxstrip__total">{items.length}</span>
        <button
          type="button"
          className="ctxstrip__icon"
          onClick={toggle}
          aria-label="Hide context"
          aria-expanded
        >
          <ChevronRight size={14} strokeWidth={1.5} aria-hidden />
        </button>
      </header>

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

      <ul className="ctxstrip__list">
        {items.map((item) => (
          <Chip key={item.id} sessionId={sessionId} item={item} />
        ))}
      </ul>
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
