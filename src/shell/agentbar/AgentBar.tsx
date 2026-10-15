/**
 * The agent bar (handoff §4): a one-line composer at the bottom of the active
 * cluster. Sending brings the cluster's agent tab forward, or opens one, and
 * the conversation continues there.
 *
 * This slice has the harness and its model, the prompt and Send. The model
 * picker, the mode indicator and the context chips come later.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AgentBarStatus } from "../state/agentBar";
import { useBarSlots } from "./slots";
import { strings, type HarnessWords } from "./strings";
import "../../agent-tokens.css";
import "./agentbar.css";

export interface AgentBarProps {
  /** What `agent-tab/harnesses` said about this cluster and its agent tab. */
  status: AgentBarStatus;
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

/** `hint` as a sentence about `words`' harness; `null` for one the bar does not word. */
function hintText(hint: string, words: HarnessWords): string | null {
  const known = Object.prototype.hasOwnProperty.call(strings.hint, hint);
  return known ? strings.hint[hint](words) : null;
}

export default function AgentBar({ status, onSend }: AgentBarProps) {
  const S = useBarSlots();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const harness = status.running ?? status.current;
  const words = status.harnesses.find((h) => h.harness === harness);
  const failed = (err: unknown) => {
    const code = err instanceof Error ? err.message : "failed";
    setFailure(
      code === "harness" && words
        ? strings.notReady(words.name)
        : (strings.refusal[code] ?? strings.refusal.failed),
    );
  };

  // One line until there is more to show, then as tall as the text up to the
  // CSS max-height, past which it scrolls.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [draft]);

  const blocked = status.blocked;
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
        failed(err);
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
    (words?.hint ? hintText(words.hint, words) : null);

  return (
    <S.Frame
      notice={notice !== null && <S.Notice text={notice} />}
      harness={
        <S.Harness name={words?.name ?? null} model={status.running ? status.model : null} />
      }
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
