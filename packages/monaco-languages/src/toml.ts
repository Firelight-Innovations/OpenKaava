/**
 * A TOML grammar, because Monaco does not ship one.
 *
 * `monaco-editor` 0.56 bundles 84 basic languages and TOML is not among them
 * (checked, not assumed: `esm/vs/languages/definitions/` has `ini`, `yaml`,
 * `xml` and no `toml`). The Files app mapped `.toml` to the `ini` grammar as an
 * admitted stand-in, and named the follow-up itself: "a ~30-line Monarch
 * tokenizer registered next to this table under a real `toml` id". This is that.
 *
 * `docs/design-notes/monaco-languages.md` carries the long form: the five ways `ini`
 * is concretely wrong on `.veistra`, `veistra.toml` and `Cargo.toml`; why the grammar moved
 * out of `apps/files/` into `packages/`, and why `index.ts` then exports a `registerToml`
 * rather than three loose setters; and why every token name here is borrowed, not invented.
 */
import type * as monaco from "monaco-editor/editor/editor.api";

/**
 * The language id. Exported rather than a literal at each call site: three editors name it,
 * and `isTomlPath` in `./index.ts` must agree with Monaco's extension list without importing it.
 */
export const TOML_LANGUAGE_ID = "toml";

/** Lowercase, dot-less, matching the `extensionOf` helpers on both sides. */
export const TOML_EXTENSIONS = ["toml", "veistra"] as const;

/**
 * Comments, brackets, and what the editor auto-closes. `#` only: TOML has no block comment
 * and no `;` — that second one is an `ini` habit, and inheriting it would let this grammar
 * quietly accept a character that makes the file fail to parse in Rust.
 */
export const TOML_CONFIGURATION: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "#" },
  brackets: [
    ["[", "]"],
    ["{", "}"],
  ],
  autoClosingPairs: [
    { open: "[", close: "]" },
    { open: "{", close: "}" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    { open: "[", close: "]" },
    { open: "{", close: "}" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

/**
 * The Monarch tokenizer. No validation, no folding provider, no language service: a lexer
 * says what a run of characters *looks* like, not whether the document is well-formed. A
 * `.veistra` with a duplicate table is coloured perfectly and is still rejected by Rust, the
 * half that gets to have an opinion. Every token name it emits is one `vs-dark` already
 * colours, which is what lets every Veistra theme keep `rules: []` — see the design notes.
 */
export const TOML_LANGUAGE: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".toml",

  /**
   * TOML's escape set, which is shorter than most: `\b \t \n \f \r \" \\`, plus
   * the two unicode forms. Notably **not** `\'` — a literal string is literal,
   * and there is nothing to escape inside one.
   */
  escapes: /\\(?:[btnfr"\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

  tokenizer: {
    root: [
      // --- table headers ------------------------------------------------
      // `[[tool]]` before `[tool]`: they start with the same character, and the
      // shorter rule would take half of the longer one and leave a stray
      // bracket, precisely the bug the `ini` stand-in has on `veistra.toml`.
      // Anchored with `^`, as `ini.js` and `yaml.js` both are, so a header is told
      // apart from an array *value* by where it sits rather than what is inside it.
      // Every capture group is spelled out because Monarch maps an array of
      // tokens onto groups one for one and requires them to cover the match.
      [/^(\s*)(\[\[)([^[\]]*)(\]\])/, ["", "metatag", "metatag", "metatag"]],
      [/^(\s*)(\[)([^[\]]*)(\])/, ["", "metatag", "metatag", "metatag"]],

      // --- keys ---------------------------------------------------------
      // Deliberately not anchored, so the keys inside an inline table
      // (`{ a = 1, b = 2 }`) are keys too; a table header cannot be caught here
      // because it has no `=`. The character class is TOML's bare-key set,
      // `A-Za-z0-9_-`, and the `-` is the whole reason this rule is not `ini`'s:
      // every key Veistra writes has one in it.
      [/("(?:[^"\\]|\\.)*"|'[^']*')(\s*)(=)/, ["key", "", "delimiter"]],
      [/([A-Za-z0-9_-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*)(\s*)(=)/, ["key", "", "delimiter"]],

      { include: "@whitespace" },

      // --- strings ------------------------------------------------------
      // Triple quotes first, or `"""` opens and immediately closes an empty
      // basic string and the body of the document is tokenized as code.
      [/"""/, { token: "string", next: "@multilineBasic" }],
      [/'''/, { token: "string", next: "@multilineLiteral" }],
      [/"/, { token: "string", next: "@basic" }],
      [/'/, { token: "string", next: "@literal" }],

      // --- dates and times ----------------------------------------------
      // Before the numbers, and that ordering is the entire point: `1979-05-27`
      // begins with four digits, so a number rule reaching it first would shred
      // a date into an integer, a minus, and two more integers. Offset
      // date-time, local date-time and local date in one rule, trailing parts
      // optional because TOML makes them so.
      [/\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/, "number"],
      // Local time, which has no date in front of it at all.
      [/\d{2}:\d{2}:\d{2}(?:\.\d+)?/, "number"],

      // --- numbers ------------------------------------------------------
      // `inf` and `nan` are floats in TOML, signed like any other.
      [/[+-]?(?:inf|nan)\b/, "number.float"],
      [/0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*/, "number.hex"],
      [/0o[0-7](?:_?[0-7])*/, "number.octal"],
      [/0b[01](?:_?[01])*/, "number.binary"],
      // Float before integer, or `3.14` is read as `3` and then `.14`. The
      // `_?` between digits is TOML's readability separator — `1_000_000`.
      [/[+-]?\d(?:_?\d)*(?:\.\d(?:_?\d)*)?[eE][+-]?\d(?:_?\d)*/, "number.float"],
      [/[+-]?\d(?:_?\d)*\.\d(?:_?\d)*/, "number.float"],
      [/[+-]?\d(?:_?\d)*/, "number"],

      // --- the rest -----------------------------------------------------
      [/\b(?:true|false)\b/, "keyword"],
      // Arrays and inline tables. No state for either: their contents are the
      // same values this state already knows, and TOML lets an array span
      // lines, so a state that popped at end of line would be wrong anyway.
      [/[[\]{}]/, "delimiter"],
      [/,/, "delimiter"],
    ],

    whitespace: [
      [/[ \t\r\n]+/, ""],
      // Anywhere on the line, not just at the start of one — TOML allows a
      // comment after a value, and `veistra.toml` uses that.
      [/#.*$/, "comment"],
    ],

    basic: [
      [/[^\\"]+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/"/, { token: "string", next: "@pop" }],
    ],

    literal: [
      // No escapes at all: that is what makes it literal, and it is why a
      // Windows path is usually written in one.
      [/[^']+/, "string"],
      [/'/, { token: "string", next: "@pop" }],
    ],

    multilineBasic: [
      // The closing delimiter is matched before the bulk rule can eat it, and
      // the lone `"` rule below it lets a quote inside the body stay a quote.
      [/"""/, { token: "string", next: "@pop" }],
      [/[^\\"]+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/"/, "string"],
    ],

    multilineLiteral: [
      [/'''/, { token: "string", next: "@pop" }],
      [/[^']+/, "string"],
      [/'/, "string"],
    ],
  },
};
