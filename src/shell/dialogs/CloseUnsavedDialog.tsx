/**
 * "Close this file with unsaved changes?" — asked when a File Viewer's tab is
 * closed from the pane strip while its file has edits that exist nowhere else.
 *
 * A File Viewer used to ask this itself, from its own tab row. With one file per
 * viewer the tab row is the pane's, and the pane strip closes an instance
 * without consulting it, so the shell asks instead, from what the viewer
 * reported (`viewerSubjects`). The safe answer is the first button and the one
 * `Dialog` focuses.
 */
import Dialog from "./Dialog";

export interface CloseUnsavedDialogProps {
  /** The file's name, as its tab reads. */
  name: string;
  onKeep: () => void;
  onDiscard: () => void;
}

export default function CloseUnsavedDialog({ name, onKeep, onDiscard }: CloseUnsavedDialogProps) {
  return (
    <Dialog label={`Close ${name} without saving`} onCancel={onKeep}>
      <div className="dialogs__confirm">
        <p>
          <strong>{name}</strong> has unsaved changes. Closing it now discards them.
        </p>
        <div className="dialogs__confirm-actions">
          <button type="button" className="k-btn k-btn--secondary" onClick={onKeep}>
            Keep open
          </button>
          <button type="button" className="k-btn k-btn--danger" onClick={onDiscard}>
            Close without saving
          </button>
        </div>
      </div>
    </Dialog>
  );
}
