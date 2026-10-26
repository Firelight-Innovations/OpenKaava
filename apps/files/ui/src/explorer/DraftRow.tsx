/**
 * The row you type a new file's name into — or an existing one's new name.
 *
 * It sits in the tree where the entry is going to sit, wearing the same indent,
 * the same icon column and the same height as every other row — because the
 * question it is asking is "what is this called", and asking it in a dialog
 * would take the answer out of the place the answer belongs. VS Code's model,
 * and the reason it feels like naming a thing rather than filling in a form.
 *
 * A rename is the same row with the name already in it, which is why there is
 * one component and not two: renaming is not a different gesture from naming,
 * it is naming something that already had one. The row *replaces* the entry's
 * own row for the duration rather than joining the list beside it — the entry
 * is not gaining a sibling, it is being re-labelled where it stands.
 */
import type { DraftKind } from "../ContextMenu";
import { fileIconUrl, folderIconUrl } from "@veistra/file-icons";
import { useInlineName } from "../useInlineName";

/** One sentence, used as both the placeholder and the accessible name — they
 *  are asking the same question and a screen reader should hear it once. */
function promptFor(mode: "create" | "rename", kind: DraftKind): string {
  const noun = kind === "dir" ? "folder" : "file";
  return mode === "rename" ? `New name for this ${noun}` : `Name for the new ${noun}`;
}

export default function DraftRow({
  kind,
  mode,
  initialName,
  depth,
  id,
  indent,
  gutter,
  busy,
  onCommit,
  onCancel,
}: {
  kind: DraftKind;
  /** Naming something new, or re-naming something that exists. */
  mode: "create" | "rename";
  /** What the field starts with. `""` for a create. */
  initialName: string;
  /** The depth the finished entry will have — one below the folder it goes in. */
  depth: number;
  /** Referenced by the tree's `aria-activedescendant`; see `Explorer`. */
  id: string;
  /** `TreeRow`'s two spacing constants, passed rather than re-declared. */
  indent: number;
  gutter: number;
  /** A create or rename is in flight. The field stays put and stops taking input. */
  busy: boolean;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  // How the question behaves — Enter, Escape, click-away, the empty answer, the
  // unchanged answer, what happens after a failure — is `../useInlineName`,
  // which the tab strip's rename shares. This file owns only what the question
  // *looks* like inside a tree.
  const field = useInlineName({ initial: initialName, mode, busy, onCommit, onCancel });
  const prompt = promptFor(mode, kind);

  return (
    <div
      id={id}
      role="treeitem"
      className="explorer__row explorer__row--draft"
      aria-level={depth + 1}
      style={{ paddingLeft: gutter + depth * indent }}
    >
      {/* The chevron column, held open and empty — a new folder is not open
          yet and a new file never will be. Same placeholder `TreeRow` uses. */}
      <span className="explorer__chevron explorer__chevron--none" aria-hidden="true" />

      {/* The icon updates as you type, from the same resolver the real rows
          use. It is free, and it is the earliest possible confirmation that
          `.ts` was understood as TypeScript rather than as part of the name. */}
      <img
        className="explorer__icon"
        src={kind === "dir" ? folderIconUrl(field.value, false) : fileIconUrl(field.value)}
        alt=""
        draggable={false}
      />

      <input
        ref={field.inputRef}
        className="explorer__draft"
        value={field.value}
        disabled={busy}
        onChange={(event) => field.setValue(event.target.value)}
        onKeyDown={field.onKeyDown}
        onBlur={field.onBlur}
        placeholder={prompt}
        aria-label={prompt}
        spellCheck={false}
        autoComplete="off"
        // A right-click inside the field is the browser's own edit menu, which
        // is the right menu here. Stopped so the tree does not raise its own
        // over the field the user is typing in.
        onContextMenu={(event) => event.stopPropagation()}
      />
    </div>
  );
}
