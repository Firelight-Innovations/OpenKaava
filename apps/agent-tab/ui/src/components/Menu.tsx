import type { MenuProps } from "./types";
import "./menu.css";

/**
 * A popup list: slash commands, @ mentions. Presentational only; the caller
 * owns filtering, the active item and the keys, and passes `activeId` so the
 * input can point `aria-activedescendant` at `menu-item-<id>`.
 */
export function Menu({ label, items, activeId, onPick }: MenuProps) {
  if (items.length === 0) return null;
  return (
    <ul className="at-menu" role="listbox" aria-label={label}>
      {items.map((item) => (
        <li
          key={item.id}
          id={`menu-item-${item.id}`}
          role="option"
          aria-selected={item.id === activeId}
          className={`at-menu__item${item.id === activeId ? " at-menu__item--active" : ""}`}
          // Keeps focus in the input, so typing carries on after a pick.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(item.id)}
        >
          <span className="at-menu__label">{item.label}</span>
          {item.detail && <span className="at-menu__detail">{item.detail}</span>}
        </li>
      ))}
    </ul>
  );
}
