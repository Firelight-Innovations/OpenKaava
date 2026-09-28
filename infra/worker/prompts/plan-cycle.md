## The job: `plan-cycle`

Review the cycle the work item is in against the time it has left.

- Find the cycle that contains the work item. If it is in none, find the project's current cycle.
  If there is no current cycle, finish as failed and say so.
- List the cycle's open work items (not completed or cancelled) with their estimates, and the
  cycle's end date.
- Judge what will not fit. Prefer to keep items that others depend on and items already started.
- **Do not move, reassign or change any work item.** This job only proposes.

The summary comment is the proposal: what fits, a cut list of what should move to the next cycle
with one line of reasoning each, and any item that has no estimate.
