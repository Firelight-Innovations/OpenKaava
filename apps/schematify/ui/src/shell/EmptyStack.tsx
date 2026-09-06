/**
 * The Stack Schematic's first-run empty state (PRD §12.20): "A new project
 * opens on an empty Stack Schematic with 1 action: create the first
 * service." `App.tsx` draws this in place of the canvas whenever the open
 * Stack Schematic holds no services — in place of the canvas, not of the
 * shell, because the action below is disabled and a whole-shell takeover
 * would put the Outline's `Product` and `Decisions` sections out of reach at
 * the one moment they are the only thing left to do.
 *
 * Before the app landed on tier 1, the only way here was `?view=empty-stack`:
 * a landing view that names a service cannot be reached by a project that has
 * none. That query parameter still works, and still replaces the whole shell,
 * for a human who wants to look at this state without making a project first.
 *
 * The action is drawn disabled: writing the first service needs
 * `schematify_write_node`, which is Wave 1's crate wired in by a later wave,
 * not this one.
 */
export const EMPTY_STACK_LEAD = "A new project. Nothing is drawn yet.";
export const EMPTY_STACK_ACTION = "Create the first service";

export function EmptyStack() {
  return (
    <div className="kv-empty-stack">
      <p className="kv-empty-stack__lead">{EMPTY_STACK_LEAD}</p>
      <button type="button" className="kv-empty-stack__action" disabled>
        {EMPTY_STACK_ACTION}
      </button>
    </div>
  );
}
