import { useEffect, useRef, useState } from "react";
import { X, Trash2, ArrowUp, Square, MessageSquare } from "lucide-react";
import { strings } from "../strings";
import type { SideChatProps } from "./types";
import "./sidechat.css";

/** A floating, independent conversation that leaves the main composer reachable. */
export function SideChat({
  children,
  working,
  error,
  onSend,
  onClose,
  onClear,
  onStop,
}: SideChatProps) {
  const [draft, setDraft] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [children]);
  const send = () => {
    if (!working && draft.trim()) {
      onSend(draft);
      setDraft("");
    }
  };
  return (
    <aside className="at-side" role="region" aria-label={strings.btw.title}>
      <header className="at-side__head">
        <MessageSquare size={15} aria-hidden="true" />
        <strong>{strings.btw.title}</strong>
        <button type="button" aria-label={strings.btw.clear} onClick={onClear}>
          <Trash2 size={16} />
        </button>
        <button type="button" aria-label={strings.btw.close} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="at-side__body" ref={body}>
        <p className="at-side__hint">{strings.btw.hint}</p>
        {children}
        {working && (
          <p className="at-side__hint" role="status">
            {strings.working}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="at-side__compose">
        <textarea
          ref={input}
          aria-label={strings.btw.placeholder}
          placeholder={strings.btw.placeholder}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="button"
          aria-label={working ? strings.stopTurn : strings.send}
          disabled={!working && !draft.trim()}
          onClick={working ? onStop : send}
        >
          {working ? <Square size={15} /> : <ArrowUp size={17} />}
        </button>
      </div>
    </aside>
  );
}
