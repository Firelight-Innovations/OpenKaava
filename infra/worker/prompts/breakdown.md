## The job: `breakdown`

Split the work item into child work items that together cover it.

- Each child gets a clear name, and a description with **acceptance conditions**: a short list of
  checks that decide when it is done.
- Give each child a size. If the project has estimates set up (`project_estimate`), set
  `estimate_point` from them; otherwise put `Size: S`, `M` or `L` in the description.
- Set each child's `parent` to the work item. If the work item is in a module, add each child to
  the same module.
- Aim for pieces one person or one agent session can finish. Usually three to eight. Do not create
  a child that only restates the parent.
- Do not change the parent's own name, description or state.

The summary comment lists the children by identifier with their sizes.
