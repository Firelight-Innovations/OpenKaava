/**
 * The agent bar (handoff §4): a one-line composer at the bottom of the active
 * cluster. Sending brings the cluster's agent tab forward, or opens one, and
 * the conversation continues there.
 *
 * This first slice has the harness label, the prompt and Send. The model
 * picker, the mode indicator and the context chips come later.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useBarSlots } from "./slots";
import { strings } from "./strings";
import "../../agent-tokens.css";
import "./agentbar.css";

export interface AgentBarProps {
  /** Why this cluster cannot run an agent, as a refusal code; `null` if it can. */
  blocked: string | null;
  /** What Claude still needs before it can run, as a hint key; `null` if nothing. */
  hint: string | null;
  /** Sends a prompt. Rejects with an `Error` whose message is a refusal code. */
  onSend: (text: string) => Promise<void>;
}

/**
 * The bar for one cluster. A cluster of its own gets a bar of its own, so a
 * half-typed prompt, a failed send's notice and a send in flight never follow
 * the user to another cluster's worktree.
 */
export function ClusterAgentBar({ clusterId, ...props }: AgentBarProps & { clusterId: string }) {
  return <AgentBar key={clusterId} {...props} />;
}

export default function AgentBar({ blocked, hint, onSend }: AgentBarProps) {
  const S = useBarSlots();
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
        // Only if the box still holds what was sent: the textarea stays live
        // while the send is in flight, and what was typed meanwhile is the
        // start of the next prompt. The agent tab guards its draft the same way.
        setDraft((now) => (now.trim() === text ? "" : now));
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
    <S.Frame
      notice={notice !== null && <S.Notice text={notice} />}
      harness={<S.Harness name={strings.harness} />}
      input={
        <S.Input
          ref={input}
          value={draft}
          disabled={disabled}
          onChange={setDraft}
          onKeyDown={onKeyDown}
        />
      }
      action={
        <S.Send
          disabled={disabled || sending || draft.trim() === ""}
          sending={sending}
          onClick={send}
        />
      }
    />
  );
}
