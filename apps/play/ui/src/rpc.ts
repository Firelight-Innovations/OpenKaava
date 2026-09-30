/**
 * The wire shapes `play/*` answers with, restated from
 * `src-tauri/src/godot/runner.rs` and `rpc.rs`. The pane polls `play/state`
 * with a log cursor; nothing is pushed.
 */
import { invoke } from "@openkaava/bridge";
import type { AddonState } from "../../../shared/godot";

export type RunState =
  { kind: "running" } | { kind: "stopped" } | { kind: "exited"; code: number | null };

export interface RunInfo {
  id: number;
  pid: number;
  state: RunState;
  startedAt: number;
  endedAt: number | null;
  scene: string | null;
  project: string;
  paused: boolean;
  /** True when the run was started with the capture addon's channel. */
  captureReady: boolean;
}

export type Level = "info" | "warning" | "error";

export interface LogLine {
  seq: number;
  stream: "stdout" | "stderr";
  level: Level;
  text: string;
  at: number;
}

export interface LogSlice {
  lines: LogLine[];
  nextSeq: number;
  /** The cursor had fallen off the front of the bounded log. */
  truncated: boolean;
}

export interface PlayState {
  run: RunInfo | null;
  log: LogSlice | null;
}

export interface Capture {
  /** Standard base64 PNG, no data-URI prefix. */
  png: string;
  width: number | null;
  height: number | null;
  /** Seconds the game had been running. */
  time: number;
  scene: string;
}

export interface AddonStatus {
  addon: AddonState;
  /** The game that is running started before the addon was installed. */
  needsRestart: boolean;
  readOnly: boolean;
}

export const getState = (since: number) => invoke<PlayState>("play/state", { since });
export const run = (project?: string, scene?: string) =>
  invoke<PlayState>("play/run", { project, scene });
export const stop = () => invoke<PlayState>("play/stop");
export const restart = (project?: string) => invoke<PlayState>("play/restart", { project });
export const setPaused = (paused: boolean) => invoke<PlayState>("play/pause", { paused });
export const capture = () => invoke<Capture>("play/capture");
export const addonStatus = (project?: string) =>
  invoke<AddonStatus>("play/addon-status", { project });
export const installAddon = (project?: string) =>
  invoke<AddonStatus>("play/addon-install", { project });
export const removeAddon = (project?: string) =>
  invoke<AddonStatus>("play/addon-remove", { project });
