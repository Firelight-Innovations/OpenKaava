import { useCallback, useEffect, useState } from "react";
import {
  agentSawDisable,
  agentSawEnable,
  agentSawList,
  agentSawStatus,
  agentSawThumb,
  type AgentSawStatus,
  type AgentSeen,
} from "../../bindings";

const POLL_MS = 2000;

/**
 * The images the agent has read in this terminal's environment.
 *
 * Rust's answer is a read of a small log the hook appends to, so this polls
 * while the hook is installed and stops entirely when it is not. Nothing is
 * listed, and nothing is polled, for a person who never turned it on.
 */
export function useAgentSaw(sessionId: string): {
  status: AgentSawStatus | null;
  seen: AgentSeen[];
  error: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
} {
  const [status, setStatus] = useState<AgentSawStatus | null>(null);
  const [seen, setSeen] = useState<AgentSeen[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    agentSawStatus(sessionId).then(
      (s) => live && setStatus(s),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [sessionId]);

  const installed = status?.installed ?? false;
  useEffect(() => {
    if (!installed) {
      setSeen([]);
      return;
    }
    let live = true;
    const tick = () => {
      agentSawList(sessionId).then(
        (next) => {
          if (!live) return;
          setSeen((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        },
        () => {},
      );
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [sessionId, installed]);

  const change = useCallback(
    async (call: (id: string) => Promise<AgentSawStatus>) => {
      setError(null);
      try {
        setStatus(await call(sessionId));
      } catch (e) {
        setError(String((e as { message?: string })?.message ?? e));
      }
    },
    [sessionId],
  );

  return {
    status,
    seen,
    error,
    enable: () => change(agentSawEnable),
    disable: () => change(agentSawDisable),
  };
}

const thumbs = new Map<string, string>();

/** A `data:` URL for an image the agent read, or `null` until it loads. */
export function useSeenThumb(sessionId: string, seen: AgentSeen): string | null {
  const key = `${seen.path}@${seen.modified}`;
  const [url, setUrl] = useState<string | null>(thumbs.get(key) ?? null);
  useEffect(() => {
    if (seen.missing || thumbs.has(key)) return;
    let live = true;
    agentSawThumb(sessionId, seen.path).then(
      ([mime, base64]) => {
        const data = `data:${mime};base64,${base64}`;
        thumbs.set(key, data);
        if (live) setUrl(data);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [sessionId, seen.path, seen.missing, key]);
  return seen.missing ? null : url;
}
