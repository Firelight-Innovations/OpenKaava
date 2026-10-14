/**
 * A line diff for the approval card: which lines an edit removes and adds.
 *
 * Longest common subsequence over lines, which is exact and quadratic, so it
 * is bounded: past `MAX_CELLS` the card says the change is too large instead.
 */

export interface DiffLine {
  op: " " | "+" | "-";
  text: string;
}

const MAX_CELLS = 4_000_000;

export function lineDiff(oldText: string | null, newText: string): DiffLine[] | null {
  const a = oldText === null || oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) return null;

  // lengths[i][j]: the LCS of a[i..] and b[j..].
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i] });
      i++;
      j++;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      out.push({ op: "-", text: a[i++] });
    } else {
      out.push({ op: "+", text: b[j++] });
    }
  }
  while (i < a.length) out.push({ op: "-", text: a[i++] });
  while (j < b.length) out.push({ op: "+", text: b[j++] });
  return out;
}

export function counts(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.op === "+") added++;
    if (line.op === "-") removed++;
  }
  return { added, removed };
}
