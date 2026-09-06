/**
 * The Stack Schematic's first-run empty state (PRD §12.20): "A new project
 * opens on an empty Stack Schematic with 1 action: create the first
 * service." `App.tsx` draws this whenever the open Stack Schematic holds no
 * services, which is what a genuinely new project looks like; before the app
 * landed on tier 1 the only way here was `?view=empty-stack`, since a landing
 * view that names a service can never be reached by a project that has none.
 * That query parameter still works, for a human who wants to look at this
 * state without making a project first. The action is drawn disabled: writing
 * the first service needs `schematify_write_node`, which is Wave 1's crate
 * wired in by a later wave, not this one.
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
