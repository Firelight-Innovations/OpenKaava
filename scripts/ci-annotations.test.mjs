/**
 * The fixtures below are real output shapes, not invented ones. Each was taken
 * from the tool it names — that matters more than usual here, because this
 * parser's only job is to agree with formatters nobody in this repository
 * controls, and a fixture written from memory would test the memory.
 */

import { describe, expect, it } from "vitest";
import { parse, relativize, stripAnsi, summarize, toWorkflowCommands } from "./ci-annotations.mjs";

const ROOT = "C:/Users/dev/helve/orchestrator";

/** What Prettier really writes to a colour-capable terminal, which CI is. */
const ESC = String.fromCharCode(27);

/** Findings for one tool, which is what nearly every assertion here wants. */
function from(output, tool) {
  return parse(output, ROOT).filter((f) => f.tool === tool);
}

describe("relativize", () => {
  it("strips the repo root and forward-slashes what is left", () => {
    expect(relativize("C:\\Users\\dev\\helve\\orchestrator\\src\\a.ts", ROOT)).toBe("src/a.ts");
  });

  it("matches the root case-insensitively, because Windows paths vary in case", () => {
    expect(relativize("c:/users/dev/helve/orchestrator/src/a.ts", ROOT)).toBe("src/a.ts");
  });

  it("leaves an already-relative path alone", () => {
    expect(relativize("./src/a.ts", ROOT)).toBe("src/a.ts");
  });
});

describe("typescript", () => {
  it("reads the file, line, column and code out of a tsc error", () => {
    const [found] = from(
      `src/shell/search/query.ts(42,17): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`,
      "typescript",
    );
    expect(found).toMatchObject({ file: "src/shell/search/query.ts", line: 42, col: 17 });
    expect(found.message).toContain("TS2345");
  });
});

describe("eslint", () => {
  const OUTPUT = [
    "C:\\Users\\dev\\helve\\orchestrator\\src\\shell\\Pane.tsx",
    "  12:5   error    'unused' is assigned a value but never used  no-unused-vars",
    "  40:1   warning  React Hook useEffect has a missing dependency  react-hooks/exhaustive-deps",
    "",
    "✖ 2 problems (1 error, 1 warning)",
  ].join("\n");

  it("places a finding against the path header above it", () => {
    const [found] = from(OUTPUT, "eslint");
    expect(found).toMatchObject({ file: "src/shell/Pane.tsx", line: 12, col: 5 });
    expect(found.message).toContain("no-unused-vars");
  });

  it("ignores warnings, which do not fail the build", () => {
    expect(from(OUTPUT, "eslint")).toHaveLength(1);
  });
});

describe("the three checks of our own", () => {
  it("reads clippy's nested file-then-problem block", () => {
    const [found] = from(
      [
        "clippy: new warnings beyond the baseline",
        "",
        "  src-tauri/src/apps/mod.rs",
        "    clippy::unwrap_used: 0 allowed, 3 found (+3)",
        "",
        "Fix them, or if they are genuinely intended, re-baseline with:",
      ].join("\n"),
      "clippy",
    );
    expect(found).toMatchObject({ file: "src-tauri/src/apps/mod.rs" });
    expect(found.message).toContain("clippy::unwrap_used");
  });

  it("keeps both problems when one file breaks two comment-density rules", () => {
    const found = from(
      [
        "comment density: files above their limit",
        "",
        "  scripts/generate-branding.mjs",
        "    53.3% comments (limit 50.0%)",
        "    24 consecutive comment lines (limit 20)",
        "",
        "Break the prose up, move it to a doc, or cut it. If the density is",
      ].join("\n"),
      "comment density",
    );
    expect(found).toHaveLength(2);
    expect(found.every((f) => f.file === "scripts/generate-branding.mjs")).toBe(true);
  });

  it("splits branding's flat `file: problem` lines apart", () => {
    const [found] = from(
      [
        "branding: 1 problem(s)",
        "",
        "  src-tauri/tauri.conf.json: productName is Veistra, branding.toml says FORGEWORKS",
      ].join("\n"),
      "branding",
    );
    expect(found.file).toBe("src-tauri/tauri.conf.json");
    expect(found.message).toContain("FORGEWORKS");
  });

  it("does not run past the block into the advice under it", () => {
    const found = from(
      [
        "branding: 1 problem(s)",
        "",
        "  splash.html: could not find the .splash__field image",
        "",
        "Run node scripts/check-branding.mjs --fix to rewrite them.",
      ].join("\n"),
      "branding",
    );
    expect(found).toHaveLength(1);
  });
});

describe("tests", () => {
  // Verbatim from `cargo test --workspace` on this machine, thread id and
  // backslashes included. The id is the part a hand-written fixture omits.
  it("reads a real panic line, thread id and all", () => {
    const [found] = from(
      [
        `thread 'branding::zz::probe' (74608) panicked at src-tauri\\src\\branding.rs:73:9:`,
        "assertion `left == right` failed: deliberate CI probe",
      ].join("\n"),
      "cargo test",
    );
    expect(found).toMatchObject({ file: "src-tauri/src/branding.rs", line: 73, col: 9 });
    expect(found.message).toContain("deliberate CI probe");
  });

  it("takes the panic site from cargo, not the test's declaration", () => {
    const [found] = from(
      [
        "---- branding::the_name_is_not_the_engines stdout ----",
        "thread 'branding::the_name_is_not_the_engines' panicked at src-tauri/src/branding.rs:88:9:",
        'assertion failed: !name.contains("Engine")',
      ].join("\n"),
      "cargo test",
    );
    expect(found).toMatchObject({ file: "src-tauri/src/branding.rs", line: 88, col: 9 });
    expect(found.message).toContain("assertion failed");
  });

  it("names the vitest case that failed", () => {
    const found = from(
      [
        " FAIL  src/shell/search/query.test.ts > parseQuery > keeps a quoted phrase whole",
        "AssertionError: expected 'a' to be 'b'",
        " ❯ src/shell/search/query.test.ts:31:24",
      ].join("\n"),
      "vitest",
    );
    expect(found.some((f) => f.message.includes("keeps a quoted phrase whole"))).toBe(true);
    expect(found.some((f) => f.line === 31)).toBe(true);
  });
});

describe("formatters", () => {
  it("reads the older `at line N:` rustfmt header", () => {
    const [found] = from(
      `Diff in C:\\Users\\dev\\helve\\orchestrator\\src-tauri\\src\\lib.rs at line 12:`,
      "rustfmt",
    );
    expect(found).toMatchObject({ file: "src-tauri/src/lib.rs", line: 12 });
  });

  // Taken verbatim from `cargo fmt --all -- --check` on this machine. Current
  // rustfmt writes `:N:` rather than ` at line N:`, and prefixes the path with
  // Win32's extended-length marker — both of which an invented fixture missed.
  it("reads the current header, extended-length prefix and all", () => {
    const [found] = from(
      `Diff in \\\\?\\C:\\Users\\dev\\helve\\orchestrator\\src-tauri\\src\\branding.rs:66:`,
      "rustfmt",
    );
    expect(found).toMatchObject({ file: "src-tauri/src/branding.rs", line: 66 });
  });

  it("reads prettier's warn lines", () => {
    const [found] = from("[warn] docs/branding.md", "prettier");
    expect(found.file).toBe("docs/branding.md");
  });

  // Prettier colours `warn` when it believes the terminal can take it, and
  // GitHub's runner says it can. Without the strip, this is the one check that
  // would pass everywhere except the place it has to work.
  it("still reads them when prettier has coloured the word warn", () => {
    const coloured = `[${ESC}[33mwarn${ESC}[39m] docs/branding.md`;
    expect(stripAnsi(coloured)).toBe("[warn] docs/branding.md");
    expect(from(coloured, "prettier")[0].file).toBe("docs/branding.md");
  });

  it("does not mistake a prettier line for an eslint path header", () => {
    const output = ["[warn] src/a.ts", "  3:3  error  Unexpected debugger  no-debugger"].join("\n");
    expect(from(output, "eslint")).toHaveLength(0);
  });
});

describe("when nothing matches", () => {
  it("names the stage rather than reporting nothing", () => {
    const found = parse(
      [
        "> veistra-orchestrator@0.1.0 build",
        "> tsc && vite build",
        "",
        "some unparseable disaster",
      ].join("\n"),
      ROOT,
    );
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("pnpm build");
  });

  it("stays silent on a clean run", () => {
    expect(parse("", ROOT)).toHaveLength(0);
  });
});

describe("workflow commands", () => {
  it("emits a placeable annotation when there is a file", () => {
    const [command] = toWorkflowCommands([
      { tool: "rustfmt", file: "src/a.rs", line: 4, col: 2, message: "bad" },
    ]);
    expect(command).toBe("::error file=src/a.rs,line=4,col=2,title=rustfmt::bad");
  });

  // Observed on the first red run: an annotation with line 0 is accepted and
  // then never drawn in the diff, which is the one place it was meant to appear.
  it("falls back to line one when the checker reports per file", () => {
    const [command] = toWorkflowCommands([{ tool: "clippy", file: "src/a.rs", message: "bad" }]);
    expect(command).toBe("::error file=src/a.rs,line=1,title=clippy::bad");
  });

  it("leaves tsc and eslint to the runner's own matchers", () => {
    const commands = toWorkflowCommands([
      { tool: "eslint", file: "a.ts", line: 1, message: "x" },
      { tool: "typescript", file: "b.ts", line: 1, message: "y" },
      { tool: "clippy", file: "c.rs", line: 1, message: "z" },
    ]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("title=clippy");
  });

  it("falls back to a bare annotation when there is not", () => {
    const [command] = toWorkflowCommands([{ tool: "build", message: "broke" }]);
    expect(command).toBe("::error title=build::broke");
  });

  it("escapes the characters that would end the command early", () => {
    const [command] = toWorkflowCommands([{ tool: "t", message: "100% done\nthen more" }]);
    expect(command).toContain("100%25 done%0Athen more");
  });
});

describe("summary", () => {
  it("groups by tool and counts each", () => {
    const text = summarize([
      { tool: "eslint", file: "src/a.ts", line: 4, message: "one" },
      { tool: "eslint", file: "src/b.ts", line: 9, message: "two" },
      { tool: "prettier", file: "c.md", message: "three" },
    ]);
    expect(text).toContain("### eslint (2)");
    expect(text).toContain("### prettier (1)");
    expect(text).toContain("verify failed — 3 problem(s)");
  });

  it("escapes a pipe so one message cannot break the table", () => {
    expect(summarize([{ tool: "t", message: "a | b" }])).toContain("a \\| b");
  });

  // The runner annotates these two itself, so they are dropped from the
  // annotations — but the summary is meant to be the whole picture of what
  // broke, and a table missing every type error would not be that.
  it("keeps the tools the annotations leave out", () => {
    const text = summarize([{ tool: "typescript", file: "a.ts", line: 1, message: "TS2345" }]);
    expect(text).toContain("### typescript (1)");
  });
});
