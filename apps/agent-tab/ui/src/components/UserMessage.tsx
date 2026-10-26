import { strings } from "../strings";
import { useSlots } from "./registry";
import type { UserMessageProps } from "./types";
import { referenceParts } from "../mentions";
import "./items.css";
import "./composer-effects.css";

export function UserMessage({ text, pending = false }: UserMessageProps) {
  const S = useSlots();
  return (
    <div className={pending ? "at-item at-user at-user--pending" : "at-item at-user"}>
      <div className="at-sr">{strings.you}</div>
      <div className="at-user__text">
        {referenceParts(text).map((part, i) =>
          part.uri ? (
            <span key={i} className="at-chip at-chip--reference" title={part.uri}>
              @{part.text}
            </span>
          ) : (
            <span key={i}>{part.text}</span>
          ),
        )}
      </div>
      {pending && <S.Note text={strings.starting} />}
    </div>
  );
}
