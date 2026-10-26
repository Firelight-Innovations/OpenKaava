# Security policy

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private vulnerability reporting: go to the
[Security tab](https://github.com/Firelight-Innovations/Veistra/security) and
choose **Report a vulnerability**. That opens a thread visible only to you and
the maintainers, and it keeps the report, the discussion and the eventual
advisory in one place.

If that route is unavailable to you for any reason, email
**braden.seaborn@firelightinnovations.com** with `Veistra security` in the subject
line.

Useful things to include, in rough order of how much they help: what an attacker
gets, the smallest sequence of steps that demonstrates it, the commit or release
you saw it on, and whether it needs the user to open a particular project or
install a particular tool.

## What to expect, and when

| | |
|---|---|
| Acknowledgement that a human has read it | 3 business days |
| An assessment — confirmed or not, and how severe | 10 business days |
| A fix, or a written plan with dates | 90 days |

This is a small project and those are commitments about *responsiveness*, not
about how fast a fix can be engineered. If a deadline is going to slip you will
hear that it is slipping rather than hear nothing.

Disclosure is coordinated by default: the advisory is published once a fix is
available, and you are credited unless you would rather not be. If the 90 days
run out without a fix, publish. A deadline that can be extended indefinitely by
the party being reported to is not a deadline.

## Supported versions

Everything before 1.0 is supported only on `main`. There are no maintenance
branches and no backports; a fix lands on `main` and the next release carries
it.

## What is in scope, and why this matters more than usual here

The orchestrator is a desktop application that reads a project manifest,
resolves paths against the filesystem, and starts tool processes that talk to it
over JSON-RPC. That is a program whose ordinary job is running other programs,
which makes a narrow class of bug much more serious than it would be in a web
application.

Reports in that class are the ones most wanted:

- Anything that lets a **project file** — `veistra.toml`, the contents of a
  `.veistra/` directory, a checked-out tool repository — cause code to run that
  the user did not ask to run. Opening an untrusted project should not be the
  same act as executing it.
- Anything that lets a **mounted tool** reach past the protocol boundary
  described in `docs/tool-protocol.md`: reading or writing outside the project,
  driving the shell, or reaching another tool's state.
- Path traversal in manifest resolution, checkout resolution, or the file
  browser.
- Anything that turns the terminal or the process supervisor into arbitrary
  command execution from data.

The planned app download system will eventually fetch and execute code from a
remote source. It is not built yet, and the decisions about how it authenticates
what it downloads are being made before it is, precisely because retrofitting
them is how projects acquire their first serious advisory. A report that
anticipates that surface is welcome, but note that a vulnerability in code that
does not exist yet is a design conversation — open it as a Discussion or a
regular issue instead.

Out of scope: findings from an automated scanner with no demonstrated impact,
missing hardening headers on the local webview, and anything that requires an
attacker who already has code execution on the machine as the user. If you are
not sure which side of that line something falls, report it privately and let us
work it out.
