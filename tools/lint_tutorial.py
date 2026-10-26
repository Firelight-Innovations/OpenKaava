#!/usr/bin/env python3
"""Lint the prose inside a tutorial content file.

The tutorials' words live as string literals in `apps/tutorial/ui/src/content/`,
and `ste_lint.py` reads Markdown. This pulls the prose-bearing block bodies out
into a scratch `.md` and lints that, so line numbers in the report point at the
extracted prose rather than at the TypeScript.

`code` and `keys` blocks are skipped: a command is not prose, and linting one
flags every flag as a spelling error.

Usage: python -X utf8 tools/lint_tutorial.py apps/tutorial/ui/src/content/search.ts
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

STRING = r'"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|`(?:[^`\\]|\\.)*`'
TAKEAWAY_RE = re.compile(r"takeaway:\s*(" + STRING + r")", re.DOTALL)
BLOCK_RE = re.compile(r'kind:\s*"(\w+)"\s*,\s*body:\s*(' + STRING + r")", re.DOTALL)

PROSE_KINDS = {"text", "heading", "step", "note", "soon"}
TOOLS = Path(__file__).resolve().parent


def decode(literal):
    quote = literal[0]
    inner = literal[1:-1]
    inner = inner.replace("\\" + quote, quote)
    inner = inner.replace("\\n", "\n").replace("\\t", "\t")
    return inner.replace("\\\\", "\\")


CODE_SPAN_RE = re.compile(r"`[^`]+`")


def unbacktick(body):
    """Stand each `code` span up as a same-length word starting with a capital.

    The linter blanks code spans to spaces before it splits sentences, so a
    sentence opening with `Ctrl+V` begins, after masking, with whitespace and
    then a lowercase letter -- and the split never fires. The sentence gets
    glued to the one before it and reported as a run-on that is not there.

    A placeholder keeps the code span counted as the one word it is, matches
    nothing in any wordlist, and starts with a capital so the boundary is
    seen. Same length in, same length out, so reported columns stay true.
    """
    return CODE_SPAN_RE.sub(lambda m: "C" + "x" * (len(m.group(0)) - 1), body)


def deemphasise(body):
    """Blank out `**bold**` markers, keeping every column where it was.

    The linter splits sentences on `(?<=[.!?])\\s+(?=[A-Z0-9`])`, so a sentence
    opening with `**Double-click**` starts on `*` and never splits from the one
    before it. Two clean sentences then get reported as one 53-word run-on, and
    a writer who trusts the number rewrites prose that was already fine.

    Two spaces rather than deletion: the report's columns stay true to the
    line. The markers carry no words, so nothing is hidden from the wordlists
    by removing them -- inline code is masked by the linter itself.
    """
    return unbacktick(body.replace("**", "  "))


def extract(src_path):
    text = src_path.read_text(encoding="utf-8")
    lines = ["# " + src_path.stem]
    takeaway = TAKEAWAY_RE.search(text)
    if takeaway:
        lines += ["", deemphasise(decode(takeaway.group(1)))]
    for match in BLOCK_RE.finditer(text):
        kind, literal = match.group(1), match.group(2)
        if kind not in PROSE_KINDS:
            continue
        body = deemphasise(decode(literal))
        lines += ["", "## " + body if kind == "heading" else body]
    return "\n".join(lines) + "\n"


def main(argv):
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    src = Path(argv[1]).resolve()
    if not src.exists():
        print("no such file: {}".format(src), file=sys.stderr)
        return 2

    # Named after the stem so two agents linting two different tutorials at the
    # same time cannot land on the same scratch file.
    out_dir = Path(tempfile.gettempdir()) / "veistra-tutorial-lint" / src.stem
    out_dir.mkdir(parents=True, exist_ok=True)
    md = out_dir / (src.stem + ".md")
    md.write_text(extract(src), encoding="utf-8")

    result = subprocess.run(
        [sys.executable, "-X", "utf8", str(TOOLS / "ste_lint.py"), str(md)] + argv[2:],
        cwd=str(TOOLS.parent),
    )
    print("\nextracted prose: {}".format(md), file=sys.stderr)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv))
