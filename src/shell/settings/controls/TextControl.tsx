/**
 * A line of free text — a font family, a path, a name.
 *
 * The commit rule is the number field's, and for the same reason: the text is
 * local until blur or Enter, because every intermediate spelling of a font name
 * is a value Rust would happily store and hand back. See `useDraft`.
 *
 * Nothing here validates. A font this machine does not have is a legitimate
 * thing to type — `appearance.ts` keeps the bundled stack behind whatever is
 * entered precisely so it degrades — and the shell has no way to tell a
 * misspelling from a font that will exist on the next machine this profile
 * syncs to.
 */
import { useDraft } from "./useDraft";

export default function TextControl({
  value,
  placeholder,
  label,
  onChange,
}: {
  value: string;
  placeholder: string;
  label: string;
  onChange: (next: string) => void;
}) {
  const [draft, setDraft] = useDraft(value);

  const commit = () => {
    if (draft === value) return;
    onChange(draft);
  };

  return (
    <input
      className="k-field__input k-field__input--mono settings-field"
      type="text"
      spellCheck={false}
      aria-label={label}
      placeholder={placeholder}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}
