/**
 * What a cluster can wear instead of its initials: an emoji, and one of a few
 * tints behind it. The data is `ClusterIcon` in `bindings.ts`; this file is the
 * vocabulary both the picker and the chip read, so they cannot disagree about
 * which colours exist.
 *
 * The tints are keys, not colours. `clusterIcon.css` maps each key to an accent
 * token, which is how they stay right in both themes without a hex in here.
 */
import type { Cluster, ClusterIcon } from "../bindings";
import { monogram } from "./clusterList";

/** The fixed palette, in the order the picker offers it. Keep in step with `clusterIcon.css`. */
export const ICON_COLORS = ["blue", "green", "violet", "coral", "amber"] as const;
export type IconColor = (typeof ICON_COLORS)[number];

/** The palette key to draw, or `undefined` for neutral — also for a key this build does not know. */
export function iconColorOf(icon: ClusterIcon | null | undefined): IconColor | undefined {
  const key = icon?.color;
  return ICON_COLORS.find((c) => c === key);
}

export interface EmojiEntry {
  emoji: string;
  /** What the search field matches against; lower-case. */
  name: string;
}

/** A curated set for developers and game makers. Inline on purpose: no picker dependency. */
export const EMOJI: readonly EmojiEntry[] = [
  { emoji: "🚀", name: "rocket launch ship" },
  { emoji: "🔥", name: "fire hot" },
  { emoji: "⚡", name: "lightning fast zap" },
  { emoji: "✨", name: "sparkles new" },
  { emoji: "🐛", name: "bug fix" },
  { emoji: "🔧", name: "wrench tool" },
  { emoji: "🔨", name: "hammer build" },
  { emoji: "⚙️", name: "gear settings" },
  { emoji: "🧪", name: "test tube experiment" },
  { emoji: "🧰", name: "toolbox" },
  { emoji: "📦", name: "package box release" },
  { emoji: "🛠️", name: "tools" },
  { emoji: "💻", name: "laptop code" },
  { emoji: "🖥️", name: "desktop monitor" },
  { emoji: "⌨️", name: "keyboard" },
  { emoji: "🧠", name: "brain ai" },
  { emoji: "🤖", name: "robot agent bot" },
  { emoji: "👾", name: "alien game monster" },
  { emoji: "🎮", name: "game controller play" },
  { emoji: "🕹️", name: "joystick arcade" },
  { emoji: "🎲", name: "dice" },
  { emoji: "🧩", name: "puzzle piece plugin" },
  { emoji: "🎨", name: "palette art design" },
  { emoji: "🖌️", name: "paintbrush" },
  { emoji: "🎬", name: "clapper film video" },
  { emoji: "🎵", name: "music note audio" },
  { emoji: "🔊", name: "speaker sound" },
  { emoji: "📷", name: "camera screenshot" },
  { emoji: "🌍", name: "earth world globe" },
  { emoji: "🏔️", name: "mountain terrain" },
  { emoji: "🌲", name: "tree forest" },
  { emoji: "🌋", name: "volcano" },
  { emoji: "⚔️", name: "swords combat" },
  { emoji: "🛡️", name: "shield security" },
  { emoji: "🗡️", name: "dagger" },
  { emoji: "🏰", name: "castle" },
  { emoji: "🐉", name: "dragon" },
  { emoji: "🦀", name: "crab rust" },
  { emoji: "🐍", name: "snake python" },
  { emoji: "🦊", name: "fox" },
  { emoji: "🐙", name: "octopus git" },
  { emoji: "🌱", name: "seedling sprout" },
  { emoji: "💎", name: "gem diamond" },
  { emoji: "🔒", name: "lock private" },
  { emoji: "🔑", name: "key" },
  { emoji: "📊", name: "chart stats" },
  { emoji: "🗺️", name: "map" },
  { emoji: "🧭", name: "compass" },
  { emoji: "⭐", name: "star favorite" },
];

/** Columns in the picker's grid; the arrow keys move by this much for up and down. */
export const EMOJI_COLUMNS = 8;

/**
 * Whether typed or pasted text is something to use as an icon: short, and it
 * contains a pictograph. Rejects plain words so "rocket" filters the grid
 * rather than becoming an icon.
 */
export function looksLikeEmoji(text: string): boolean {
  const t = text.trim();
  if (t === "" || Array.from(t).length > 16) return false;
  return /\p{Extended_Pictographic}/u.test(t);
}

/** The text a chip draws: the emoji, or the initials when there is none. */
export function chipText(cluster: Pick<Cluster, "name" | "icon">): string {
  const emoji = cluster.icon?.emoji.trim() ?? "";
  return emoji !== "" ? emoji : monogram(cluster.name);
}
