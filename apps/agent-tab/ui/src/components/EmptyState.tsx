import { strings } from "../strings";
import { useSlots } from "./registry";
import type { EmptyStateProps } from "./types";
import "./frame.css";

/** A short prompt, three example tasks and the keys (handoff §2.1.6). */
export function EmptyState({ blocked, setupHint, onExample }: EmptyStateProps) {
  const S = useSlots();
  return (
    <div className="at-empty">
      <h2 className="at-empty__heading">{strings.empty.heading}</h2>
      <p>{strings.empty.body}</p>
      {blocked && <S.Hint text={strings.refusal[blocked] ?? blocked} />}
      {setupHint !== null && <S.Hint text={setupHint} />}
      <ul className="at-empty__examples">
        {strings.empty.examples.map((text) => (
          <li key={text}>
            <button
              type="button"
              className="k-btn k-btn--ghost k-btn--sm"
              onClick={() => onExample(text)}
            >
              {text}
            </button>
          </li>
        ))}
      </ul>
      <h3 className="at-empty__keys">{strings.empty.keysHeading}</h3>
      <dl className="at-keys">
        {strings.empty.keys.map(([key, action]) => (
          <div key={key}>
            <dt>
              <kbd>{key}</kbd>
            </dt>
            <dd>{action}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
