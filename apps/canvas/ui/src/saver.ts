/**
 * The debounced, one-at-a-time save loop behind the canvas. Pure of React and of
 * Excalidraw so the timing rules can be tested with fake timers.
 *
 * The rules, each of which was a way to lose or corrupt a drawing:
 * - a change waits `delay` ms after the *last* change, so dragging does not
 *   write the file forty times;
 * - only one write is in flight; a change that arrives during one is written
 *   after it, with the mtime the first write returned, never with a stale one;
 * - a write the backend refuses as stale stops the loop (`conflict`) rather than
 *   retrying: the file changed under us and someone has to choose;
 * - any other failure is `error`, and the next change tries again.
 */
import type { SceneFile } from "./scene";

export type SaveState = "saved" | "dirty" | "saving" | "conflict" | "error";

export interface SaverOptions {
  delay: number;
  /** Write `scene` if the file is still at `baseMtime`; resolve to the new mtime. */
  write: (scene: SceneFile, baseMtime: number | null) => Promise<number | null>;
  /** True for the refusal that means "the file changed on disk". */
  isStale: (err: unknown) => boolean;
  onState: (state: SaveState, detail?: string) => void;
}

export class Autosaver {
  private pending: { scene: SceneFile; sig: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private inFlightSig: string | null = null;
  private base: number | null = null;
  private savedSig: string | null = null;
  private stopped = false;
  private conflicted = false;

  constructor(private readonly opts: SaverOptions) {}

  /** What is on disk now: the mtime, and the signature of its content. */
  setBase(mtime: number | null, sig: string): void {
    this.base = mtime;
    this.savedSig = sig;
    this.pending = null;
    this.conflicted = false;
    this.clearTimer();
    this.opts.onState("saved");
  }

  get mtime(): number | null {
    return this.base;
  }

  get hasUnsaved(): boolean {
    return this.pending !== null || this.inFlight !== null;
  }

  /** The editor changed. A signature equal to the saved one is not a change. */
  schedule(scene: SceneFile, sig: string): void {
    if (this.stopped || this.conflicted) return;
    if (sig === this.savedSig && this.inFlight === null) {
      this.pending = null;
      this.clearTimer();
      this.opts.onState("saved");
      return;
    }
    // The state already on its way to disk (queued, or being written) is not a
    // change. Excalidraw reports it again after every re-render, and the write
    // itself re-renders through `onState`; treating each report as a change
    // either starves the debounce or writes the same drawing in a loop.
    const latest = this.pending ? this.pending.sig : this.inFlight ? this.inFlightSig : null;
    if (latest !== null && sig === latest) {
      if (this.pending) {
        this.pending = { scene, sig };
        if (this.timer === null) this.arm();
      }
      return;
    }
    this.pending = { scene, sig };
    this.opts.onState("dirty");
    this.clearTimer();
    this.arm();
  }

  private arm(): void {
    this.timer = setTimeout(() => void this.flush(), this.opts.delay);
  }

  /** Write whatever is pending now, and wait for it (and any write in flight). */
  async flush(): Promise<void> {
    this.clearTimer();
    if (this.inFlight) {
      await this.inFlight;
      if (!this.pending) return;
    }
    if (!this.pending || this.conflicted) return;
    const { scene, sig } = this.pending;
    this.pending = null;
    this.opts.onState("saving");
    this.inFlightSig = sig;
    const run = (async () => {
      try {
        this.base = await this.opts.write(scene, this.base);
        this.savedSig = sig;
        if (this.pending) {
          this.opts.onState("dirty");
        } else {
          this.opts.onState("saved");
        }
      } catch (err) {
        // Put the change back so a retry or a conflict resolution still has it.
        this.pending ??= { scene, sig };
        if (this.opts.isStale(err)) {
          this.conflicted = true;
          this.opts.onState("conflict");
        } else {
          this.opts.onState("error", err instanceof Error ? err.message : String(err));
        }
      }
    })();
    this.inFlight = run;
    await run;
    // A second caller may have started the next write while this one waited.
    if (this.inFlight === run) this.inFlight = null;
  }

  /** Conflict resolved in favour of the local drawing: write over the disk version. */
  async overwrite(diskMtime: number | null): Promise<void> {
    this.base = diskMtime;
    this.conflicted = false;
    await this.flush();
  }

  /** Stop for good; nothing pending is written. */
  dispose(): void {
    this.stopped = true;
    this.clearTimer();
    this.pending = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
