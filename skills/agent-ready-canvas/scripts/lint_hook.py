"""PostToolUse hook: after an agent writes or edits a canvas file, lint it and push failures back.

Exit 2 + stderr makes the harness show the problems to the agent, which then has to fix them, so
the structure rules hold even when the skill was not consulted. Non-canvas files pass silently.

settings.json:
  {"hooks": {"PostToolUse": [{"matcher": "Write|Edit|MultiEdit",
     "hooks": [{"type": "command",
                "command": "python \"$CLAUDE_PROJECT_DIR/.claude/skills/agent-ready-canvas/scripts/lint_hook.py\""}]}]}}
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from canvas_lint import lint  # noqa: E402
from excal import load  # noqa: E402


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    path = (event.get("tool_input") or {}).get("file_path") or ""
    if not path.lower().endswith((".json", ".excalidraw")) or not os.path.isfile(path):
        return 0
    try:
        doc = load(path)
    except (ValueError, OSError):
        return 0
    if not isinstance(doc, dict) or doc.get("type") != "excalidraw" or "elements" not in doc:
        return 0
    r = lint(doc)
    if r["pass"]:
        return 0
    lines = [f"Canvas {path} is not agent-ready (agent-ready-canvas skill). Failed: {', '.join(r['failed_checks'])}."]
    for k in r["failed_checks"]:
        for item in r["issues"].get(k, [])[:5]:
            lines.append(f"  {k}: {item}")
    lines.append("Put every element in a named frame and group multi-part objects. See "
                 ".claude/skills/agent-ready-canvas/SKILL.md; for a flat canvas run scripts/canvas_restructure.py.")
    print("\n".join(lines), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
