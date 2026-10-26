import { describe, expect, it } from "vitest";

import { compileNeedle, compilePathFilter, parseQuery, toQueryString } from "./query";
import type { MatchFlags } from "./query";

const LITERAL: MatchFlags = { regex: false, caseSensitive: false, wholeWord: false };

/** `g` is always set, so `.test()` twice on one regex would consult lastIndex. */
function matches(regex: RegExp, text: string): boolean {
  regex.lastIndex = 0;
  return regex.test(text);
}

describe("parseQuery", () => {
  it("keeps plain words as the needle", () => {
    expect(parseQuery("render scene").needle).toBe("render scene");
  });

  it("sorts globs, negated globs and directories into their own buckets", () => {
    const parsed = parseQuery("*.ts !*.spec.ts src/");
    expect(parsed.include).toEqual(["*.ts"]);
    expect(parsed.exclude).toEqual(["*.spec.ts"]);
    expect(parsed.paths).toEqual(["src/"]);
    expect(parsed.needle).toBe("");
  });

  it("reads the three prefixes case-insensitively and normalizes the keyword", () => {
    const parsed = parseQuery("PATH:src/shell EXT:.RS kind:script");
    expect(parsed.paths).toEqual(["src/shell"]);
    expect(parsed.extensions).toEqual(["rs"]);
    expect(parsed.kinds).toEqual(["script"]);
  });

  it("keeps a quoted phrase as needle text rather than parsing it", () => {
    const parsed = parseQuery('"path:not-a-filter"');
    expect(parsed.paths).toEqual([]);
    expect(parsed.needle).toBe("path:not-a-filter");
  });

  it("drops nothing it cannot parse", () => {
    expect(parseQuery("kind:nonsense").needle).toBe("kind:nonsense");
    expect(parseQuery("-verbose").needle).toBe("-verbose");
    expect(parseQuery("foo:bar").needle).toBe("foo:bar");
  });

  it("runs an unterminated quote to the end instead of throwing", () => {
    expect(parseQuery('"half a phrase').needle).toBe("half a phrase");
  });
});

describe("the round trip", () => {
  // The invariant toQueryString exists to satisfy: a filter chip rewrites the
  // whole field, so parse(serialize(p)) must deep-equal p for every p the
  // parser can produce.
  const cases = [
    "",
    "render scene",
    "*.ts !*.spec.ts src/ path:src/shell ext:rs kind:script needle",
    '"a quoted phrase"',
    "-verbose",
    "kind:nonsense",
    "**/*.tsx",
  ];

  for (const raw of cases) {
    it(`survives ${JSON.stringify(raw)}`, () => {
      const once = parseQuery(raw);
      expect(parseQuery(toQueryString(once))).toEqual(once);
    });
  }

  it("does not quote a multi-word needle, which would rewrite what was typed", () => {
    expect(toQueryString(parseQuery("render scene"))).toBe("render scene");
  });

  it("quotes a needle that would otherwise reparse as a filter", () => {
    expect(toQueryString({ ...parseQuery(""), needle: "*.md" })).toBe('"*.md"');
  });
});

describe("compileNeedle", () => {
  it("escapes a literal needle", () => {
    const compiled = compileNeedle("a.b", LITERAL);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(matches(compiled.regex, "a.b")).toBe(true);
    expect(matches(compiled.regex, "axb")).toBe(false);
  });

  it("always sets the global flag, because callers count every match on a line", () => {
    const compiled = compileNeedle("x", LITERAL);
    expect(compiled.ok && compiled.regex.flags).toContain("g");
  });

  it("bounds a whole alternation rather than only its last branch", () => {
    const compiled = compileNeedle("foo|bar", { ...LITERAL, regex: true, wholeWord: true });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(matches(compiled.regex, "a foo b")).toBe(true);
    expect(matches(compiled.regex, "foobar")).toBe(false);
  });

  it("reports a half-typed regex instead of throwing", () => {
    const compiled = compileNeedle("(", { ...LITERAL, regex: true });
    expect(compiled.ok).toBe(false);
  });
});

describe("compilePathFilter", () => {
  it("matches a bare glob against the basename at any depth", () => {
    const keep = compilePathFilter(parseQuery("*.md"));
    expect(keep("docs/deep/notes.md")).toBe(true);
    expect(keep("docs/deep/notes.ts")).toBe(false);
  });

  it("anchors a glob containing a slash to the whole path", () => {
    const keep = compilePathFilter(parseQuery("src/*.ts"));
    expect(keep("src/main.ts")).toBe(true);
    expect(keep("apps/src/main.ts")).toBe(false);
  });

  it("crosses directories on **", () => {
    const keep = compilePathFilter(parseQuery("**/*.ts"));
    expect(keep("apps/files/ui/src/main.ts")).toBe(true);
  });

  it("excludes a directory and everything beneath it", () => {
    // The naive translation of `node_modules/` is `^node_modules$`, which
    // excludes nothing a real tree contains.
    const keep = compilePathFilter(parseQuery("!node_modules/"));
    expect(keep("repo/node_modules/pkg/index.js")).toBe(false);
    expect(keep("repo/src/index.js")).toBe(true);
  });

  it("scopes by a path fragment without it being rooted", () => {
    const keep = compilePathFilter(parseQuery("path:src/shell"));
    expect(keep("/c/repo/src/shell/query.ts")).toBe(true);
    expect(keep("/c/repo/src/views/StackView.tsx")).toBe(false);
  });

  it("filters by extension and by kind", () => {
    expect(compilePathFilter(parseQuery("ext:rs"))("src-tauri/src/lib.rs")).toBe(true);
    expect(compilePathFilter(parseQuery("ext:rs"))("src/main.ts")).toBe(false);
    expect(compilePathFilter(parseQuery("kind:veistra"))("repo/veistra.toml")).toBe(true);
    expect(compilePathFilter(parseQuery("kind:veistra"))("repo/Cargo.toml")).toBe(false);
  });

  it("treats an empty axis as no restriction, not as match-nothing", () => {
    expect(compilePathFilter(parseQuery("just a needle"))("anything.txt")).toBe(true);
  });
});
