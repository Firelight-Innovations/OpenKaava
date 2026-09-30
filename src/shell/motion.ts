/**
 * The shell's motion scale. Every animated thing in the shell uses one of these;
 * a component that writes its own `transition={{ ... }}` is a bug, because a
 * scale's whole point is that the window moves like one piece of software, and
 * that is lost the moment two regions disagree about what "quick" means. Why
 * springs rather than durations, and where these numbers came from:
 * `docs/design-notes/shell-core.md`.
 */
import type { Transition } from "framer-motion";

/** The default. Tab rules, layout shifts, anything the pointer just caused. */
export const snap: Transition = {
  type: "spring",
  stiffness: 700,
  damping: 42,
  mass: 0.7,
};

/** Larger travel: the panel collapsing, a detached window arriving. */
export const settle: Transition = {
  type: "spring",
  stiffness: 420,
  damping: 38,
};

/** Popovers and menus. The one tween in the set: these have no gesture behind
 *  them to inherit velocity from, and a spring on a 4px fade just adds settling
 *  time to something that should already be readable. */
export const instant: Transition = {
  duration: 0.09,
  ease: [0.4, 0, 0.2, 1],
};

/** Leaving is faster than arriving; dismissal should never make you wait.
 *  Constants because this one transition is needed in two languages — framer's
 *  object below, and a CSS `transition` shorthand for `.toolwindow__surface`, a
 *  plain positioned div rather than a `motion.div`. Written twice by hand they
 *  would drift; written once here they cannot. */
const INSTANT_OUT_MS = 60;
const INSTANT_OUT_EASE: [number, number, number, number] = [0.4, 0, 1, 1];

export const instantOut: Transition = {
  duration: INSTANT_OUT_MS / 1000,
  ease: INSTANT_OUT_EASE,
};

/** `instantOut` as a CSS `transition` timing, for the CSS-side callers. */
export const instantOutCss = `${INSTANT_OUT_MS}ms cubic-bezier(${INSTANT_OUT_EASE.join(", ")})`;

/** `instantOut` in ms, for the caller that has to know when a CSS transition
 *  it started has finished. */
export const instantOutMs = INSTANT_OUT_MS;

/** The shared open/close for every popover and menu in the shell — the health
 *  list, the eight menus, the type filter, settings. One variant object rather
 *  than a copy per component, so they cannot drift apart. */
export const popover = {
  initial: { opacity: 0, y: -4, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1, transition: instant },
  exit: { opacity: 0, y: -2, scale: 0.99, transition: instantOut },
};

/* --- settings, which is a place rather than a mode ------------------------
 *
 * Settings is attached to nothing, so it gets a sheet rather than search's
 * unroll: the window behind dims and the screen settles forward out of it. Both
 * halves are paint-only, for the reason the search clip is — this screen holds
 * scroll containers and a full-width form, and animating a box would re-layout
 * every one of them per frame. `docs/design-notes/shell-core.md` has the rest.
 */

/** How long dismissal takes. Faster than arrival, the rule `instantOut` states. */
const SETTINGS_OUT_MS = 90;

const settingsOut: Transition = {
  duration: SETTINGS_OUT_MS / 1000,
  ease: [0.4, 0, 1, 1],
};

/** The window behind, dimmed. Nothing moves; only the wash arrives. */
export const settingsBackdrop = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: settle },
  exit: { opacity: 0, transition: settingsOut },
};

/** The screen itself. 1.5% and eight pixels, deliberately almost nothing: it
 *  should read as having been there, one layer back, the whole time, and any
 *  more travel blurs the text through the scale. */
export const settingsScreen = {
  initial: { opacity: 0, scale: 0.985, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0, transition: settle },
  exit: { opacity: 0, scale: 0.99, y: 4, transition: settingsOut },
};

/** The boot spinner's arc. Linear and infinite — it reports nothing but life. */
export const spinArc: Transition = {
  duration: 0.9,
  ease: "linear",
  repeat: Infinity,
};

/* --- rail pages, which pull out of the rail rather than appear -------------
 *
 * One progress value runs 0 (tucked into the rail) to 1 (settled). Arriving
 * uses `snap`, so a page opened and closed in quick succession reverses from
 * wherever it got to. Leaving is a short tween, faster than arriving by the
 * rule `instantOut` states. `docs/design-notes/shell-core.md` has the rest.
 */

/** How long a rail page takes to tuck back into the rail. */
export const pageOut: Transition = {
  duration: 0.12,
  ease: [0.4, 0, 1, 1],
};

/** Where a dock/expand toggle restarts the reveal from, so the geometry change
 *  reads as a short pull rather than replaying the whole pull-out. */
export const PAGE_TOGGLE_FROM = 0.55;
