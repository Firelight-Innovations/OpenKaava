import type { RingProps } from "./types";
import "./meters.css";

const RADIUS = 6;
const AROUND = 2 * Math.PI * RADIUS;

/** A 16px ring that fills clockwise from the top, coloured by its tone. */
export function Ring({ share, tone }: RingProps) {
  const filled = Math.min(1, Math.max(0, share)) * AROUND;
  return (
    <svg
      className="at-ring"
      data-tone={tone}
      viewBox="0 0 16 16"
      width={16}
      height={16}
      aria-hidden="true"
    >
      <circle className="at-ring__track" cx={8} cy={8} r={RADIUS} />
      <circle
        className="at-ring__fill"
        cx={8}
        cy={8}
        r={RADIUS}
        strokeDasharray={`${filled} ${AROUND}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}
