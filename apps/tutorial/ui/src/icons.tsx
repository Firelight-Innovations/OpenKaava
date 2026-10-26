/**
 * The Tutorials app's glyphs.
 *
 * App-local rather than imported from the shell's `src/ui/Icon.tsx`, for the
 * reason `apps/home/ui/src/icons.tsx` gives at length: an app reaches its host
 * through `@veistra/bridge` and nothing else, and reaching into the shell's source
 * for a component would make this pane a piece of the shell that happens to live
 * in a folder.
 *
 * Drawn to the same convention all the same — 24×24, 2px stroke, Tabler
 * outline, `currentColor`. Colour comes from the CSS token on the parent; no
 * icon here hardcodes a hex.
 */

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

/** The tick on a finished tutorial. Drawn at 11px, so the stroke is the only
 *  thing carrying it — no fill, no box. */
export function Check(props: IconProps) {
  return (
    <Outline {...props}>
      <path d="M5 12l5 5L20 7" />
    </Outline>
  );
}
