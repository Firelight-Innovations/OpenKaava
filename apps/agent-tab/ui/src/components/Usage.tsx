import { strings } from "../strings";
import type { UsageProps } from "./types";
import "./items.css";

export function Usage({ used, size }: UsageProps) {
  return <div className="at-usage">{strings.usage(used, size)}</div>;
}
