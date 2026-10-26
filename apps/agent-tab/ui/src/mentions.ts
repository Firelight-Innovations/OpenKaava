/** Caret-local @ completion. Inserted references retain a stable project URI. */
export interface MentionHit {
  uri: string;
  kind: string;
  title: string;
  detail?: string;
}
export interface ContextChip {
  id: string;
  label: string;
  kind: string;
  uri?: string;
  command?: string;
}

/** Visible chips retain their structured identity until the prompt is sent. */
export function withChips(text: string, chips: readonly ContextChip[]): string {
  const skills = chips
    .map((chip) => chip.command?.trim())
    .filter((command): command is string => Boolean(command))
    .map((command) =>
      command.startsWith("$") || command.startsWith("/") ? command : `/${command}`,
    )
    .join(" ");
  const refs = chips
    .filter((chip) => chip.uri)
    .map((chip) => `[@${chip.label.replace(/[[\]]/g, "")}](<${chip.uri}>)`)
    .join(" ");
  return [skills, refs, text].filter(Boolean).join(" ");
}

export function referenceParts(text: string): Array<{ text: string; uri?: string }> {
  const parts: Array<{ text: string; uri?: string }> = [];
  let at = 0;
  for (const match of text.matchAll(/\[@([^\]]+)\]\(<((?:veistra|https):\/\/[^>]+)>\)/g)) {
    if (match.index! > at) parts.push({ text: text.slice(at, match.index) });
    parts.push({ text: match[1], uri: match[2] });
    at = match.index! + match[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}
export interface MentionQuery {
  start: number;
  end: number;
  query: string;
}

export function mentionAt(text: string, caret: number): MentionQuery | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1].length - 1, end: caret, query: match[1] };
}

export function insertMention(
  text: string,
  query: MentionQuery,
  hit: MentionHit,
): { text: string; caret: number } {
  const token = `[@${hit.title.replace(/[[\]]/g, "")}](<${hit.uri}>) `;
  return {
    text: text.slice(0, query.start) + token + text.slice(query.end),
    caret: query.start + token.length,
  };
}

/** Only explicit inserted references are resolved, never arbitrary URLs in prose. */
export function mentionedUris(text: string): string[] {
  return [...new Set([...text.matchAll(/\[@[^\]]+\]\(<(veistra:\/\/[^>]+)>\)/g)].map((m) => m[1]))];
}
