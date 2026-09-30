/**
 * Every glyph in the shell.
 *
 * The paths are copied out of `docs/handoffs/shell-spec.html` rather than
 * pulled from an icon package. The handoff draws its icons at specific stroke
 * weights inside specific viewBoxes, and those drawings *are* the spec — a
 * package's version of "search" would be a different shape at a different
 * weight, which is the one thing this pass is not allowed to introduce. Where a
 * glyph the shell needs later isn't drawn in the handoff, take it from Tabler
 * outline at 1.5–2px and add it here.
 *
 * Every icon strokes `currentColor`, so colour comes from the CSS token on the
 * parent. No icon hardcodes a hex.
 *
 * `BrandGlyph` is the exception to the first paragraph: it is the identity
 * rather than an icon, and it comes from `branding.toml`.
 */

import { MARK_PATH, MARK_VIEW_BOX } from "../branding.generated";

interface IconProps {
  size?: number;
  className?: string;
}

/**
 * The 24×24 outline base. `strokeWidth` defaults to 2 because that is what the
 * handoff uses for nearly everything at bar scale; the two exceptions pass
 * their own.
 */
function Outline({
  size = 24,
  strokeWidth = 2,
  className,
  children,
  linejoin,
}: IconProps & {
  strokeWidth?: number;
  children: React.ReactNode;
  linejoin?: "round";
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin={linejoin}
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

/**
 * The product's mark. Today that is an avocado: one outline with the seed as a
 * counter cut out of it. Filled, not stroked, and monochrome — the three-tone
 * version exists (`assets/kaava-mark-colour.svg`) but is drawn only by Home's
 * 52px lockup, because this glyph appears at 15px on the title bar and at 38px
 * as the placeholder every tool shares until it earns its own icon, and the
 * hairlines separating the tones close up long before either of those sizes.
 *
 * The seed reads as a hole because the outline is wound clockwise and the seed
 * counter-clockwise, under the default nonzero fill rule. That is a property of
 * the path data, not of anything here — see `branding.toml`'s note on `mark`.
 *
 * The geometry is generated out of the SVG that `branding.toml` names, rather
 * than copied here or loaded as a file. Copying is what it used to be, and the
 * comment claiming the copy was faithful was the only thing checking it.
 * Loading it as an `<img>` was the other option and is worse: this glyph is
 * drawn on the title bar and again as a tool placeholder, and an `<img>` cannot
 * inherit `currentColor` — every call site would have to decide a colour, which
 * is exactly what the rest of this file exists not to do.
 */
export function BrandGlyph({ size = 15, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={MARK_VIEW_BOX}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d={MARK_PATH} />
    </svg>
  );
}

export function WarningTriangle({ size = 12, className }: IconProps) {
  return (
    <Outline size={size} className={className}>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4" />
    </Outline>
  );
}

export function Search({ size = 14, className }: IconProps) {
  return (
    <Outline size={size} className={className}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L20 20" />
    </Outline>
  );
}

export function Plus({ size = 13, className }: IconProps) {
  return (
    <Outline size={size} className={className}>
      <path d="M12 5v14M5 12h14" />
    </Outline>
  );
}

/** Marks the worktree tab, and heads the branch row inside it. */
export function GitBranch({
  size = 13,
  strokeWidth = 2,
  className,
}: IconProps & { strokeWidth?: number }) {
  return (
    <Outline size={size} strokeWidth={strokeWidth} className={className}>
      <circle cx="7" cy="6" r="2" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="9" r="2" />
      <path d="M7 8v8M17 11v1a3 3 0 0 1-3 3H8" />
    </Outline>
  );
}

/** A submenu's disclosure arrow (`MenuItemList`). */
export function ChevronRight({ size = 13, className }: IconProps) {
  return (
    <Outline size={size} className={className} linejoin="round">
      <path d="M9 6l6 6-6 6" />
    </Outline>
  );
}

/** The mirror of `ChevronRight`. */
export function ChevronLeft({ size = 13, className }: IconProps) {
  return (
    <Outline size={size} className={className} linejoin="round">
      <path d="M15 6l-6 6 6 6" />
    </Outline>
  );
}

/**
 * Closes a terminal tab. Sits in the same slot as the agent-finished dot and
 * replaces it on hover/keyboard focus rather than appearing beside it, so it
 * is drawn small and centred like the dot it stands in for.
 */
export function Close({ size = 9, className }: IconProps) {
  return (
    <Outline size={size} strokeWidth={2} className={className}>
      <path d="M5 5l14 14M19 5L5 19" />
    </Outline>
  );
}

/**
 * Settings, at the trailing edge of the status bar — sliders, not a cog. The
 * knob circles are filled with the surface behind them so the rules appear to
 * pass under rather than through, which means the fill has to be told what it
 * is sitting on.
 */
export function Sliders({
  size = 14,
  knobFill = "var(--surface)",
  className,
}: IconProps & { knobFill?: string }) {
  return (
    <Outline size={size} className={className}>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="9" cy="6" r="2.2" fill={knobFill} />
      <circle cx="15" cy="12" r="2.2" fill={knobFill} />
      <circle cx="8" cy="18" r="2.2" fill={knobFill} />
    </Outline>
  );
}

/** The checked box in the search type filter. Heavier stroke, small viewport. */
export function Check({ size = 9, className }: IconProps) {
  return (
    <Outline size={size} strokeWidth={3.5} className={className} linejoin="round">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Outline>
  );
}

/**
 * The boot spinner: a full circle in the line colour with a quarter arc in the
 * accent laid over it. Only the arc rotates, so this returns both and the
 * caller animates the group.
 */
export function BootArc({ size = 28, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <circle cx="12" cy="12" r="9" stroke="var(--line)" />
      <path d="M12 3a9 9 0 0 1 9 9" stroke="var(--accent)" />
    </svg>
  );
}

/* --- window controls -------------------------------------------------------
   Drawn in a 10×10 box at 1.2px, not the 24×24 outline set. They are OS
   furniture rather than application iconography, and the handoff draws them
   noticeably lighter than everything else in the title bar. */

function Control({ size = 10, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

/**
 * An issue, in the GitHub list. Tabler outline at 2px, per the header's rule
 * for a glyph the handoff does not draw — the shell spec predates this panel.
 *
 * A ring around a dot rather than GitHub's own filled issue mark, so it reads
 * at the same weight as everything else in the panel. Colour comes from the
 * state token on the parent, which is what lets one glyph serve open, closed
 * and every other state without a variant for each.
 */
export function IssueDot({ size = 13, className }: IconProps) {
  return (
    <Outline size={size} className={className}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.5" />
    </Outline>
  );
}

/** A pull request: `GitBranch` with the arm coming back rather than leaving,
 *  which is the distinction GitHub's own two icons draw. Deliberately not
 *  reused from `GitBranch` — the two sit in one list, and telling a pull
 *  request from an issue at a glance is the whole job of the column. */
export function PullRequest({ size = 13, className }: IconProps) {
  return (
    <Outline size={size} className={className}>
      <circle cx="7" cy="6" r="2" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="18" r="2" />
      <path d="M7 8v8M17 16V9a3 3 0 0 0-3-3h-3" />
      <path d="M13 3l-2 3 2 3" />
    </Outline>
  );
}

/** The Agents page's chip. Tabler's `robot`, outline. */
export function Robot({ size = 14, className }: IconProps) {
  return (
    <Outline size={size} className={className} linejoin="round">
      <path d="M6 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z" />
      <path d="M12 2v2M9 12v9M15 12v9M5 16l4-2M15 14l4 2M9 18h6M10 8v.01M14 8v.01" />
    </Outline>
  );
}

/** The Cost Tracker page's chip. Tabler's `receipt`, outline. */
export function Receipt({ size = 14, className }: IconProps) {
  return (
    <Outline size={size} className={className} linejoin="round">
      <path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-3-2-2 2-2-2-2 2-2-2-3 2M9 7h6M9 11h6M13 15h2" />
    </Outline>
  );
}

/** The Projects page's chip. Tabler's `layout-kanban`, outline. */
export function Kanban({ size = 14, className }: IconProps) {
  return (
    <Outline size={size} className={className} linejoin="round">
      <path d="M4 4h6M14 4h6" />
      <path d="M4 10a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2zM14 10a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2z" />
    </Outline>
  );
}

export function WindowMinimise(props: IconProps) {
  return (
    <Control {...props}>
      <path d="M1 5h8" />
    </Control>
  );
}

export function WindowMaximise(props: IconProps) {
  return (
    <Control {...props}>
      <rect x="1.6" y="1.6" width="6.8" height="6.8" />
    </Control>
  );
}

export function WindowClose(props: IconProps) {
  return (
    <Control {...props}>
      <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
    </Control>
  );
}
