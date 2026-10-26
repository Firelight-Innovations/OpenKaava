import { useEffect, useState } from "react";
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  File,
  FileText,
  Folder,
  Frame,
  GitBranch,
  SquareKanban,
  Link,
  MessageSquare,
  MousePointer2,
  Palette,
  Search,
  Shapes,
  Slash,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { strings } from "../strings";
import type { MenuItem, MenuProps } from "./types";
import "./menu.css";

/** The glyph a row leads with, by what it is. Rows without a known kind get none. */
const ICON: Record<string, LucideIcon> = {
  design: Palette,
  canvas: Shapes,
  frame: Frame,
  comment: MessageSquare,
  "design-comment": MessageSquare,
  pm: SquareKanban,
  issue: Link,
  cluster: GitBranch,
  file: FileText,
  folder: Folder,
  context: Bookmark,
  selection: MousePointer2,
  search: Search,
  skill: Sparkles,
  command: Slash,
  other: File,
};

/**
 * A popup list: slash commands, @ mentions. Presentational only; the caller
 * owns filtering, the active item and the keys, and passes `activeId` so the
 * input can point `aria-activedescendant` at `menu-item-<id>`.
 *
 * A nested list drills down in place, one level at a time, with the level's
 * name and a back arrow at the top, so it never grows sideways out of a
 * narrow pane.
 */
export function Menu({
  label,
  items,
  activeId,
  onPick,
  path: controlledPath,
  onPathChange,
  title,
  status,
  search,
  onBack,
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
  if (items.length === 0 && !status) return null;
  let list = items;
  const trail: MenuItem[] = [];
  for (const id of path) {
    const next = list.find((i) => i.id === id);
    if (!next?.children) break;
    trail.push(next);
    list = next.children;
  }
  const heading = trail[trail.length - 1]?.label ?? title ?? label;
  const back = trail.length > 0 ? () => setPath(path.slice(0, trail.length - 1)) : onBack;
  const choose = (item: MenuItem) => {
    if (item.disabled) return;
    if (item.children) setPath([...path.slice(0, trail.length), item.id]);
    else onPick(item.id);
  };
  return (
    <div className="at-menu" data-nested={trail.length > 0 ? "" : undefined}>
      <div className="at-menu__head">
        {back && (
          <button
            type="button"
            className="at-menu__back"
            aria-label={strings.skills.back}
            title={strings.skills.back}
            onMouseDown={(event) => event.preventDefault()}
            onClick={back}
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
        )}
        <span className="at-menu__title">{heading}</span>
      </div>
      {search && trail.length === 0 && (
        <div className="at-menu__search" data-empty={search.query ? undefined : ""}>
          <Search size={13} aria-hidden="true" />
          <span>{search.query || search.placeholder}</span>
        </div>
      )}
      {list.length > 0 && (
        <ul className="at-menu__list" role="listbox" aria-label={heading}>
          {list.map((item) => {
            const Icon = item.kind ? ICON[item.kind] : undefined;
            return (
              <li
                key={item.id}
                id={`menu-item-${item.id}`}
                role="option"
                aria-selected={item.id === activeId}
                aria-disabled={item.disabled}
                tabIndex={-1}
                className={`at-menu__item${item.id === activeId ? " at-menu__item--active" : ""}`}
                // Keeps focus in the input, so typing carries on after a pick.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(item)}
              >
                {Icon && <Icon className="at-menu__icon" size={14} aria-hidden="true" />}
                <span className="at-menu__label">{item.label}</span>
                {item.detail && <span className="at-menu__detail">{item.detail}</span>}
                {item.children && (
                  <ChevronRight className="at-menu__arrow" size={14} aria-hidden="true" />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {status && (
        <div className="at-menu__status" role="status">
          {status}
        </div>
      )}
    </div>
  );
}
