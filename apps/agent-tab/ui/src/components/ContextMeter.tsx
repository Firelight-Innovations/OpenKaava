import { shareOf, toneOf } from "../meters";
import { strings } from "../strings";
import { useSlots } from "./registry";
import type { ContextCategory, ContextMeterProps } from "./types";
import "./meters.css";

/** How many category colours there are (`--k-context-1` to `-6`); more cycle. */
const HUES = 6;

/**
 * How full the context window is: a short bar and a percentage, and on hover a
 * card that breaks the window down. Without a breakdown from the agent, the
 * card has one row for what is used and one for what is free.
 */
export function ContextMeter({ used, size, categories }: ContextMeterProps) {
  const S = useSlots();
  if (used === null || size === null || size <= 0) return null;
  const share = shareOf(used, size);
  const rows: ContextCategory[] = categories?.length
    ? categories
    : [{ id: "used", label: strings.context.used, tokens: used }];
  const free = Math.max(0, size - used);
  return (
    <S.HoverCard
      label={strings.context.meter(share)}
      trigger={
        <>
          <span className="at-minibar" data-tone={toneOf(share)} aria-hidden="true">
            <span className="at-bar__fill" style={{ width: `${share * 100}%` }} />
          </span>
          <span className="at-minibar__share" aria-hidden="true">
            {strings.percent(share)}
          </span>
        </>
      }
    >
      <div className="at-card__head">
        <span>{strings.context.heading}</span>
        <span className="at-card__figure">{strings.context.summary(used, size)}</span>
      </div>
      <span className="at-stack" aria-hidden="true">
        {rows.map((row, i) => (
          <span
            key={row.id}
            className={`at-stack__part at-hue-${(i % HUES) + 1}`}
            style={{ width: `${shareOf(row.tokens, size) * 100}%` }}
          />
        ))}
      </span>
      <dl className="at-rows">
        {rows.map((row, i) => (
          <div key={row.id} className="at-rows__row">
            <dt>
              <span className={`at-swatch at-hue-${(i % HUES) + 1}`} />
              {row.label}
            </dt>
            <dd>
              {strings.tokens(row.tokens)}
              <span className="at-rows__share">{strings.percent(shareOf(row.tokens, size))}</span>
            </dd>
          </div>
        ))}
        <div className="at-rows__row at-rows__row--free">
          <dt>
            <span className="at-swatch at-swatch--free" />
            {strings.context.free}
          </dt>
          <dd>
            {strings.tokens(free)}
            <span className="at-rows__share">{strings.percent(shareOf(free, size))}</span>
          </dd>
        </div>
      </dl>
    </S.HoverCard>
  );
}
