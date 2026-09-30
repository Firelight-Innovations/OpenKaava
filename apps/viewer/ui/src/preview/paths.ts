/**
 * Link and image targets in a Markdown file, resolved against that file.
 *
 * Pure string work with no `node:path`, because this runs in a webview and
 * because a Windows path here can carry either separator (the backend returns
 * whatever `Display` produced). The result keeps the separator the source file
 * used, so a resolved path compares equal to the one the tab strip already holds
 * for the same file.
 */

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export type LinkTarget =
  | { kind: "anchor"; id: string }
  | { kind: "external"; url: string }
  | { kind: "file"; path: string; fragment: string }
  | { kind: "blocked" };

/** A URL that names no scheme and is not root-relative or protocol-relative. */
export function isRelative(href: string): boolean {
  return (
    href !== "" &&
    !SCHEME.test(href) &&
    !href.startsWith("/") &&
    !href.startsWith("\\") &&
    !href.startsWith("#")
  );
}

/**
 * `href` resolved against the folder holding `fromFile`, or `null` when it climbs
 * out of the filesystem root or is not a relative reference.
 *
 * The query and fragment are dropped, and percent-escapes are decoded — `my%20doc.md`
 * names the file `my doc.md`.
 */
export function resolveRelative(fromFile: string, href: string): string | null {
  if (!isRelative(href)) return null;

  const bare = href.split("#")[0].split("?")[0];
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // A stray `%` is a literal one. Use the text as written.
  }

  const sep = fromFile.includes("\\") ? "\\" : "/";
  const fromParts = fromFile.split(/[\\/]/);
  fromParts.pop();

  // A drive prefix (`C:`) or the empty first segment of a POSIX root must survive.
  const rooted = fromParts.length > 0 && (fromParts[0] === "" || /^[a-zA-Z]:$/.test(fromParts[0]));
  const head = rooted ? [fromParts.shift() as string] : [];

  const out = [...fromParts];
  for (const part of decoded.split(/[\\/]/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(part);
    }
  }

  return [...head, ...out].join(sep);
}

/** What a click on `href` should do. Never returns something unsafe to act on. */
export function classifyLink(fromFile: string, href: string): LinkTarget {
  const trimmed = href.trim();
  if (trimmed.startsWith("#")) {
    let id = trimmed.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // Use it as written.
    }
    return { kind: "anchor", id };
  }
  if (/^(https?:|mailto:)/i.test(trimmed)) return { kind: "external", url: trimmed };
  if (!isRelative(trimmed)) return { kind: "blocked" };

  const path = resolveRelative(fromFile, trimmed);
  if (path === null) return { kind: "blocked" };
  const hash = trimmed.indexOf("#");
  return { kind: "file", path, fragment: hash >= 0 ? trimmed.slice(hash + 1) : "" };
}
