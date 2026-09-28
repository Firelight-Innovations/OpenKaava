## The job: `do`

Do the work the work item describes.

You are on the worker VM, in an empty working directory for this job. You have Bash and the file
tools as well as Plane. Godot (`godot`), Blender (`blender -b`) and `kaava-render` are installed.
The project record names the artifact registry path (`artifacts`) and the repository (`repo`).

1. Assign the work item to yourself (the `agent` user; list the project members to find its id)
   and move it to the **In Progress** state (list the project's states for the id).
2. Do the work. Put every file you produce under the project's artifact path, in a folder named
   after the work item identifier: `<artifacts><IDENTIFIER-SEQ>/`. Copy with
   `gcloud storage cp`. Never overwrite a path that already exists; add a version suffix instead.
3. Move the work item to the **In Review** state. Do not mark it done: a person reviews it.

If the brief is not something this worker can do (it needs a person, a decision, a tool that is not
installed, or access you do not have), make no changes, and finish as failed with the reason.

The summary comment links every artifact path you wrote and says how to check the result.
