/**
 * The agent bar (handoff §4): a one-line composer at the bottom of the active
 * cluster. Sending brings the cluster's agent tab forward, or opens one, and
 * the conversation continues there.
 *
 * This first slice has the harness label, the prompt and Send. The model
 * picker, the mode indicator and the context chips come later.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { strings } from "./strings";
import "./agentbar.css";

export interface AgentBarProps {
  /** Why this cluster cannot run an agent, as a refusal code; `null` if it can. */
  blocked: string | null;
  /** What Claude still needs before it can run, as a hint key; `null` if nothing. */
  hint: string | null;
  /** Sends a prompt. Rejects with an `Error` whose message is a refusal code. */
  onSend: (text: string) => Promise<void>;
}

export default function AgentBar({ blocked, hint, onSend }: AgentBarProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // One line until there is more to show, then as tall as the text up to the
  // CSS max-height, past which it scrolls.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [draft]);

  const disabled = blocked !== null;
  const send = () => {
    const text = draft.trim();
    if (text === "" || sending || disabled) return;
    setSending(true);
    setFailure(null);
    onSend(text).then(
      () => {
        setDraft("");
        setSending(false);
      },
      (err: unknown) => {
        const code = err instanceof Error ? err.message : "failed";
        setFailure(strings.refusal[code] ?? strings.refusal.failed);
        setSending(false);
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  // A refusal for the whole cluster beats a setup hint, and a failed send beats both.
  const notice =
    failure ??
    (blocked !== null ? (strings.refusal[blocked] ?? strings.refusal.failed) : null) ??
    (hint !== null ? (strings.hint[hint] ?? null) : null);

  return (
    <section className="agentbar" aria-label={strings.label}>
      {notice !== null && (
        <div className="agentbar__notice" role="status">
          {notice}
        </div>
      )}
      <div className="agentbar__row">
        <span className="agentbar__harness">{strings.harness}</span>
        <textarea
          ref={input}
          className="agentbar__input"
          aria-label={strings.promptLabel}
          placeholder={strings.placeholder}
          rows={1}
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="k-btn k-btn--primary k-btn--sm"
          disabled={disabled || sending || draft.trim() === ""}
          onClick={send}
        >
          {sending ? strings.sending : strings.send}
        </button>
      </div>
    </section>
  );
}
