/**
 * Home's glyphs.
 *
 * App-local rather than imported from the shell's `src/ui/Icon.tsx`, and that is
 * the same rule the types in `App.tsx` follow: an app reaches its host through
 * `@openkaava/bridge` and nothing else. Reaching into the shell's source for a
 * component would make this pane a piece of the shell that happens to live in a
 * folder, and the point of `apps/` is that it isn't.
 *
 * Drawn to the shell's convention all the same — 24×24, 2px stroke, Tabler
 * outline, `currentColor` — because looking like a different product would be a
 * worse outcome than a little duplication. Colour comes from the CSS token on
 * the parent; no icon here hardcodes a hex.
 */

/* `MARK_VIEW_BOX` only: `Mark` below draws the three-tone version, whose
   geometry the generator cannot reduce to one path and so does not emit. The
   box is still generated, because both versions are authored in it and a
   replacement mark is allowed to change it. */
import { MARK_VIEW_BOX } from "./branding.generated";

interface IconProps {
  size?: number;
  className?: string;
}

function Outline({ size = 24, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

/**
 * The product's mark, for the lockup at the top of the page.
 *
 * The one glyph here that is neither an outline nor `currentColor`: it is the
 * identity, not an icon. At 52px this lockup is the only surface large enough
 * to carry the mark's three tones — dark skin, light flesh, brown seed. The
 * shell draws the monochrome silhouette everywhere smaller, because the
 * hairlines between the tones close up and the seed stops reading as a hole.
 *
 * So the geometry is written out here rather than generated: the generator
 * reduces the mark to one path — which is what lets every other call site draw
 * it in `currentColor` — and three drawables do not reduce.
 * `assets/kaava-mark-colour.svg` is the declared asset this copies, kept in
 * step by hand. `docs/branding.md` §6 has the argument, and why not an `<img>`.
 *
 * The strokes are `var(--bg)` because the gap between tones *is* the
 * background, not a colour. Fills are the `--mark-*` tokens, so the rule at the
 * top of this file still holds: no hex is written here. `size` is the mark's
 * height in the packet's sense — a ratio of the 24×24 box, not of the ink.
 */
export function Mark({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={MARK_VIEW_BOX}
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path
        fill="var(--mark-skin)"
        d="M12 2.4c3.3 0 7 4.2 7 10.1 0 4.8-3.1 9.1-7 9.1s-7-4.3-7-9.1C5 6.6 8.7 2.4 12 2.4z"
      />
      <path
        fill="var(--mark-flesh)"
        stroke="var(--bg)"
        strokeWidth={0.9}
        d="M12 3.85c2.85 0 5.9 3.7 5.9 8.75 0 4.15-2.65 7.75-5.9 7.75s-5.9-3.6-5.9-7.75C6.1 7.55 9.15 3.85 12 3.85z"
      />
      <circle
        fill="var(--mark-seed)"
        stroke="var(--bg)"
        strokeWidth={0.9}
        cx="12"
        cy="13.7"
        r="2.9"
      />
    </svg>
  );
}

/** New Project — a folder with a plus. */
export function FolderPlus(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M12 19h-7a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v3.5" />
      <path d="M16 19h6" />
      <path d="M19 16v6" />
    </Outline>
  );
}

/** Open Project. */
export function FolderOpen(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M5 19l2.757 -7.351a1 1 0 0 1 .936 -.649h12.307a1 1 0 0 1 .986 1.164l-.996 5.211a2 2 0 0 1 -1.964 1.625h-14.026a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v2" />
    </Outline>
  );
}

/** Clone Project — a git branch. */
export function GitBranch(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M7 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M7 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M17 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M7 8v8" />
      <path d="M9 18h6a2 2 0 0 0 2 -2v-5" />
    </Outline>
  );
}

/** Install App. A box with a plus, which reads as "add one of these" the way
 *  `FolderPlus` does — a package rather than a folder, because that is the one
 *  thing distinguishing this action from the project rows beside it. */
export function PackagePlus(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M12 21.5l-8 -4.5v-9l8 -4.5l8 4.5v4.5" />
      <path d="M12 12l8 -4.5" />
      <path d="M12 12v9.5" />
      <path d="M12 12l-8 -4.5" />
      <path d="M16 19h6" />
      <path d="M19 16v6" />
    </Outline>
  );
}

/** A tutorial card's mark. */
export function Book(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0" />
      <path d="M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0" />
      <path d="M3 6l0 13" />
      <path d="M12 6l0 13" />
      <path d="M21 6l0 13" />
    </Outline>
  );
}

/** Drop a project from the Recent list. */
export function Close(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M18 6l-12 12" />
      <path d="M6 6l12 12" />
    </Outline>
  );
}

/** New Project's own header — "back to Home". */
export function ArrowLeft(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M5 12l14 0" />
      <path d="M5 12l6 6" />
      <path d="M5 12l6 -6" />
    </Outline>
  );
}

/** A finished step in the Create rail. */
export function Check(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M5 12l5 5l10 -10" />
    </Outline>
  );
}

/** A failed step in the Create rail, and a field's inline error. */
export function AlertCircle(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />
      <path d="M12 8l0 5" />
      <path d="M12 16l.01 0" />
    </Outline>
  );
}
