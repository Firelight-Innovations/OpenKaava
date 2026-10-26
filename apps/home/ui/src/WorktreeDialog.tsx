import { useCallback, useEffect, useRef, useState } from "react";
import { VeistraRpcError, invoke } from "@veistra/bridge";
import "./home.css";

/**
 * `home/worktree-create`'s reply, mirroring `home/worktree-state`'s shape —
 * see the comment on `Project` in `App.tsx` for why this is declared here
 * rather than shared: an app's only coupling to its host is `@veistra/bridge`
 * and the shape of what crosses it. Nothing here reads the fields back; the
 * type exists so a change to the contract shows up as a type error rather
 * than a silently ignored field.
 */
interface WorktreeState {
  isRepo: boolean;
  worktree: { path: string; branch: string | null } | null;
  taken: string[];
}

export interface WorktreeDialogProps {
  /** The open project's own name, for the suggested name below. */
  projectName: string;
  /** Branch names already in use, from the `home/worktree-state` that triggered this. */
  taken: string[];
  /** The user declined, or dismissed the dialog. Nothing has been created. */
  onCancel: () => void;
  /** `home/worktree-create` succeeded. There is nothing left for the dialog to say. */
  onCreated: () => void;
}

/**
 * "Work in a separate git worktree?" — offered once, right after a project
 * opens with no worktree of its own yet. `App.tsx` decides when to show this
 * from `home/worktree-state`; this file only asks the question and, on a yes,
 * calls `home/worktree-create`.
 *
 * The easy path is declining: a cluster that just wants the project folder
 * should never have to fight this dialog to get there, so Escape, a click on
 * the scrim, and the "Work in the project folder" button all take it down
 * having touched nothing.
 */
export default function WorktreeDialog({
  projectName,
  taken,
  onCancel,
  onCreated,
}: WorktreeDialogProps) {
  const [name, setName] = useState(() => suggest(projectName, taken));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    // The suggested name is a starting point, not a commitment — selecting it
    // means the common case (typing a real name over it) doesn't start with a
    // delete-everything keystroke.
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }

      // The dialog has exactly two buttons and a field; Tab is kept inside
      // that loop rather than reaching whatever Home has drawn behind the
      // scrim, which a click-driven focus trap would otherwise let it escape
      // to.
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          "input, button:not(:disabled)",
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  // Checked on every render rather than only on submit, so the submit button
  // is already disabled before the user reaches for it — the backend still
  // re-checks everything below in its own words; this is only the early
  // warning `home/worktree-create`'s error can't give until the round trip.
  const problem = validate(name, taken);

  const submit = useCallback(() => {
    if (problem || busy) return;
    setBusy(true);
    setFailure(null);
    void invoke<WorktreeState>("home/worktree-create", { name })
      .then(() => onCreated())
      .catch((e: unknown) => {
        // Left open, not closed-and-reported: the one thing the user needs
        // next is to retype the name, and that only works if the field they
        // typed it in is still there.
        setBusy(false);
        setFailure(describe(e));
      });
  }, [problem, busy, name, onCreated]);

  return (
    <div
      className="home__worktree-scrim"
      // A pointerdown on the scrim itself, not on the dialog it wraps, reads
      // as the same "never mind" as Escape.
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="home__worktree"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="worktree-title"
      >
        <h2 className="home__worktree-title" id="worktree-title">
          Work in a separate worktree?
        </h2>
        <p className="home__worktree-text">
          A worktree gives this cluster its own checkout and branch, so its edits never mix with
          anything else open on this repository.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="home__worktree-label" htmlFor="worktree-name">
            Worktree name
          </label>
          <input
            ref={inputRef}
            id="worktree-name"
            className="home__worktree-input"
            type="text"
            value={name}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setName(e.target.value);
              setFailure(null);
            }}
          />
          {(failure ?? problem) && <p className="home__worktree-error">{failure ?? problem}</p>}
          <div className="home__worktree-actions">
            <button
              type="button"
              className="home__worktree-cancel"
              disabled={busy}
              onClick={onCancel}
            >
              Work in the project folder
            </button>
            <button
              type="submit"
              className="home__worktree-submit"
              disabled={busy || problem !== null}
            >
              {busy ? "Creating…" : "Create worktree"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Mirrors `home/worktree-create`'s own rules closely enough to catch a bad
 * name before it leaves this pane — the backend is still the authority, and
 * re-checks all of this itself in its own words; see the field's error text
 * for what it says when this early check missed something.
 */
function validate(name: string, taken: string[]): string | null {
  if (name.length === 0) return "Name can't be empty.";
  if (name !== name.trim()) return "Can't start or end with whitespace.";
  if (name.length > 100) return "100 characters, at most.";
  if (name.startsWith(".") || name.startsWith("-")) return "Can't start with “.” or “-”.";
  if (name.endsWith(".") || name.endsWith(".lock")) return "Can't end with “.” or “.lock”.";
  if (name.includes("..")) return "Can't contain “..”.";
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return "Only letters, digits, dots, dashes and underscores.";
  if (taken.includes(name)) return `"${name}" is already in use.`;
  return null;
}

/**
 * A starting point, not a guess at what the user is about to build: the
 * project's own name, cut down to the charset a worktree name is allowed,
 * with a suffix so it doesn't collide with the branch that string usually
 * already names (a repo's default branch and its folder are often the same
 * word). Checked against `taken` so the field doesn't open already invalid —
 * cheap, since `taken` is already in hand from the `home/worktree-state` that
 * triggered this dialog, and nothing here asks the host for anything new.
 */
function suggest(projectName: string, taken: string[]): string {
  const base =
    projectName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "worktree";
  let candidate = `${base}-worktree`;
  for (let n = 2; taken.includes(candidate); n += 1) {
    candidate = `${base}-worktree-${n}`;
  }
  return candidate;
}

/**
 * The message shown next to the field on a failed create. Just `.message`,
 * not `App.tsx`'s `describe` with its `[code]` prefix — the task this dialog
 * was built from is explicit that the backend's message is written to be
 * shown verbatim, and a prefix in front of it would no longer be verbatim.
 */
function describe(error: unknown): string {
  if (error instanceof VeistraRpcError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
