/** Classify known harness failures without exposing their RPC wrappers as product copy. */
import { strings } from "./strings";

export function cleanError(message: string): string {
  return message
    .replace(/^(?:(?:error|internal error|rpc error|request failed)\s*:\s*)+/i, "")
    .trim();
}

export function friendlyError(message: string): {
  title: string;
  detail: string;
  limited: boolean;
} {
  const detail = cleanError(message);
  const limited =
    /(?:usage|session|weekly|rate)\s+limit|limit\s+(?:reached|exceeded)|(?:hit|reached|exceeded)\s+(?:your |the )?limit|out of (?:usage|credits)/i.test(
      detail,
    );
  if (limited) {
    const time = /resets?\s*(?:at|in)?\s*[:·]?\s*(.+)$/i.exec(detail)?.[1];
    return {
      title: strings.errors.limit,
      detail: time
        ? `${strings.errors.reset(time.replace(/\.$/, ""))} ${strings.errors.limitHint}`
        : strings.errors.limitHint,
      limited: true,
    };
  }
  return {
    title: /cancel|interrupt|disconnect/i.test(detail)
      ? strings.errors.interrupted
      : strings.errors.generic,
    detail,
    limited: false,
  };
}
