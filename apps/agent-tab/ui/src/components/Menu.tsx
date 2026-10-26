import { useEffect, useState } from "react";
import { ChevronRight, ChevronLeft } from "lucide-react";
import { strings } from "../strings";
import type { MenuItem, MenuProps } from "./types";
import "./menu.css";

/**
 * A popup list: slash commands, @ mentions. Presentational only; the caller
 * owns filtering, the active item and the keys, and passes `activeId` so the
 * input can point `aria-activedescendant` at `menu-item-<id>`.
 */
export function Menu({
  label,
  items,
  activeId,
  onPick,
  path: controlledPath,
  onPathChange,
}: MenuProps) {
  const [localPath, setLocalPath] = useState<string[]>([]);
  const path = controlledPath ?? localPath;
  const setPath = (next: string[]) => {
    setLocalPath(next);
    onPathChange?.(next);
  };
  useEffect(() => {
    if (activeId)
      document.getElementById(`menu-item-${activeId}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);
  if (items.length === 0) return null;
  const levels: MenuItem[][] = [items];
  for (const id of path) {
    const next = levels[levels.length - 1].find((i) => i.id === id)?.children;
    if (!next) break;
    levels.push(next);
  }
  const choose = (item: MenuItem, depth: number) => {
    if (item.disabled) return;
    if (item.children) setPath([...path.slice(0, depth), item.id]);
    else onPick(item.id);
  };
  return (
    <div
      className="at-menu-shell"
      data-nested={levels.length > 1 ? "" : undefined}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        const list = target.closest("ul");
        if (!list) return;
        const rows = [...list.querySelectorAll<HTMLElement>(":scope > li")];
        const at = rows.indexOf(target.closest("li")!);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          rows[(at + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
        } else if (event.key === "ArrowLeft" || event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setPath(path.slice(0, -1));
        } else if (["ArrowRight", "Enter", " "].includes(event.key)) {
          event.preventDefault();
          target.closest<HTMLElement>("li")?.click();
        }
      }}
    >
      {levels.map((list, depth) => (
        <ul
          key={depth}
          className="at-menu"
          role="listbox"
          aria-label={depth ? `${label} ${depth}` : label}
        >
          {depth > 0 && (
            <li
              className="at-menu__back"
              role="option"
              aria-selected={false}
              tabIndex={-1}
              onClick={() => setPath(path.slice(0, depth - 1))}
            >
              <ChevronLeft size={13} />
              {strings.skills.back}
            </li>
          )}
          {list.map((item) => (
            <li
              key={item.id}
              id={`menu-item-${item.id}`}
              role="option"
              aria-selected={item.id === activeId}
              aria-disabled={item.disabled}
              aria-expanded={item.children ? path[depth] === item.id : undefined}
              tabIndex={-1}
              className={`at-menu__item${item.id === activeId ? " at-menu__item--active" : ""}`}
              // Keeps focus in the input, so typing carries on after a pick.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => {
                if (item.children) setPath([...path.slice(0, depth), item.id]);
              }}
              onClick={() => choose(item, depth)}
            >
              <span className="at-menu__label">{item.label}</span>
              {item.detail && <span className="at-menu__detail">{item.detail}</span>}
              {item.children && (
                <ChevronRight className="at-menu__arrow" size={14} aria-hidden="true" />
              )}
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}
