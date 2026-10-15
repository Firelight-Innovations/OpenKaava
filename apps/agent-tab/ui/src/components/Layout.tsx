import type { LayoutProps } from "./types";
import "./frame.css";

export function Layout({ header, transcript, composer }: LayoutProps) {
  return (
    <div className="at">
      {header}
      {transcript}
      {composer}
    </div>
  );
}
