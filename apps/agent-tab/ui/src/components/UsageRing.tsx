import { toneOf } from "../meters";
import { strings } from "../strings";
import { useSlots } from "./registry";
import type { UsageRingProps } from "./types";
import "./meters.css";

/**
 * The plan's usage limits: a ring as full as the tightest one, and on hover a
 * card with a bar per limit and when it resets. Draws nothing until the agent
 * reports a limit.
 */
export function UsageRing({ limits }: UsageRingProps) {
  const S = useSlots();
  if (limits.length === 0) return null;
  const tightest = Math.max(...limits.map((limit) => limit.share));
  return (
    <S.HoverCard
      label={strings.limits.meter(tightest)}
      trigger={<S.Ring share={tightest} tone={toneOf(tightest)} />}
    >
      <div className="at-card__head">{strings.limits.heading}</div>
      {limits.map((limit) => (
        <div key={limit.id} className="at-limit">
          <div className="at-limit__line">
            <span className="at-limit__label">{limit.label}</span>
            <span className="at-limit__used">{strings.limits.used(limit.share)}</span>
          </div>
          <span className="at-bar" data-tone={toneOf(limit.share)}>
            <span
              className="at-bar__fill"
              style={{ width: `${Math.min(1, Math.max(0, limit.share)) * 100}%` }}
            />
          </span>
          {limit.resets && <span className="at-limit__resets">{limit.resets}</span>}
        </div>
      ))}
    </S.HoverCard>
  );
}
