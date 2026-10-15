import { strings } from "../strings";
import type { PathListProps } from "./types";
import "./items.css";

export function PathList({ paths }: PathListProps) {
  if (paths.length === 0) return null;
  return (
    <ul className="at-paths" aria-label={strings.files}>
      {paths.map((path, i) => (
        <li key={`${i}:${path}`} className="at-mono">
          {path}
        </li>
      ))}
    </ul>
  );
}
