import { useEffect } from "react";
import { Search } from "../../ui/Icon";
import { accelerator, hasPrimaryModifier } from "../accelerators";
import "./search.css";

export interface SearchSlotProps {
  /** Whether the search dialog is showing. Drives `aria-expanded` only. */
  open?: boolean;
  /** Ctrl+K, or a click on the field. */
  onOpen?: () => void;
}

/**
 * The title bar's search field: a trigger, not an input.
 *
 * The query is typed into the dialog it opens (`SearchOverlay`), which is the
 * one place the field, the type filters and the results share a box. This
 * stays a button so the row never grows a second text input to focus-manage
 * and the row keeps its width whether or not search is open.
 *
 * It owns Ctrl+K because it is the thing Ctrl+K is written on — the hint chip
 * names the chord — and `hasPrimaryModifier` is the one place that decides what
 * "Ctrl" is on this platform.
 */
export default function SearchSlot({ open = false, onOpen }: SearchSlotProps = {}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (hasPrimaryModifier(e) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpen?.();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onOpen]);

  return (
    <button
      type="button"
      className="search-slot"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label="Search project files"
      aria-keyshortcuts="Control+K"
      title={`Search project files (${accelerator({ key: "K" })})`}
      onClick={onOpen}
    >
      <Search size={14} className="search-slot__glyph" />
      <span className="search-slot__label">Search project files</span>
      <kbd className="k-kbd search-slot__hint">{accelerator({ key: "K" })}</kbd>
    </button>
  );
}
