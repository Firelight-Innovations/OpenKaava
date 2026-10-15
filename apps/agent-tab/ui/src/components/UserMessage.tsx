import { strings } from "../strings";
import { useSlots } from "./registry";
import type { UserMessageProps } from "./types";
import "./items.css";

export function UserMessage({ text, pending = false }: UserMessageProps) {
  const S = useSlots();
  return (
    <div className={pending ? "at-item at-user at-user--pending" : "at-item at-user"}>
      <div className="at-item__label">{strings.you}</div>
      <div className="at-user__text">{text}</div>
      {pending && <S.Note text={strings.starting} />}
    </div>
  );
}
