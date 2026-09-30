/**
 * A project's tile: its own icon when it has one (`.kaava/icon.*`), and its
 * initial otherwise.
 *
 * A leaf module under `src/shell/` rather than inside a region, because the
 * title bar's pill and the Switch project dialog both draw it and neither
 * region may import the other. Each keeps its own tile class for size and
 * colour; `--image` is added when an icon is drawn so the class can drop the
 * letter tile's background behind a transparent image.
 */
export default function ProjectTile({
  name,
  icon,
  className,
}: {
  name: string;
  /** A `data:` URL from `useProjectIcon`, or `null` for the initial. */
  icon: string | null;
  className: string;
}) {
  if (icon !== null) {
    return (
      <span className={`${className} ${className}--image`} aria-hidden="true">
        <img src={icon} alt="" draggable={false} />
      </span>
    );
  }
  return (
    <span className={className} aria-hidden="true">
      {name.charAt(0).toUpperCase() || "?"}
    </span>
  );
}
