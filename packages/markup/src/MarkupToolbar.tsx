/**
 * The toolbar. Excalidraw's own is hidden: its tool set cannot be trimmed in
 * the pinned release and it has no slot for a Pin tool, so this one drives
 * `api.setActiveTool` instead. Icons are Lucide at 16px, as the design system
 * asks.
 */
import {
  ArrowUpRight,
  Check,
  Circle,
  Eraser,
  MapPin,
  MousePointer2,
  Pencil,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import type { ReactNode } from "react";
import type { InkSwatch } from "./palette";

export type MarkupTool =
  "selection" | "freedraw" | "arrow" | "rectangle" | "ellipse" | "text" | "eraser" | "pin";

const TOOLS: { id: MarkupTool; label: string; icon: ReactNode }[] = [
  { id: "selection", label: "Select", icon: <MousePointer2 size={16} strokeWidth={1.5} /> },
  { id: "freedraw", label: "Draw", icon: <Pencil size={16} strokeWidth={1.5} /> },
  { id: "arrow", label: "Arrow", icon: <ArrowUpRight size={16} strokeWidth={1.5} /> },
  { id: "rectangle", label: "Box", icon: <Square size={16} strokeWidth={1.5} /> },
  { id: "ellipse", label: "Ellipse", icon: <Circle size={16} strokeWidth={1.5} /> },
  { id: "text", label: "Text", icon: <Type size={16} strokeWidth={1.5} /> },
  { id: "eraser", label: "Eraser", icon: <Eraser size={16} strokeWidth={1.5} /> },
  { id: "pin", label: "Pin", icon: <MapPin size={16} strokeWidth={1.5} /> },
];

export interface MarkupToolbarProps {
  tool: MarkupTool;
  swatches: InkSwatch[];
  color: string;
  onTool: (tool: MarkupTool) => void;
  onColor: (color: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onDone: () => void;
}

export function MarkupToolbar(props: MarkupToolbarProps) {
  return (
    <div className="kaava-markup__toolbar" role="toolbar" aria-label="Markup tools">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          className="kaava-markup__btn"
          aria-label={t.label}
          title={t.label}
          aria-pressed={props.tool === t.id}
          onClick={() => props.onTool(t.id)}
        >
          {t.icon}
        </button>
      ))}
      <span className="kaava-markup__sep" />
      {props.swatches.map((s) => (
        <button
          key={s.id}
          type="button"
          className="kaava-markup__btn kaava-markup__swatch"
          aria-label={s.label}
          title={s.label}
          aria-pressed={props.color === s.color}
          style={{ ["--swatch" as string]: s.color }}
          onClick={() => props.onColor(s.color)}
        />
      ))}
      <span className="kaava-markup__sep" />
      <button
        type="button"
        className="kaava-markup__btn"
        aria-label="Undo"
        title="Undo"
        onClick={props.onUndo}
      >
        <Undo2 size={16} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        className="kaava-markup__btn"
        aria-label="Redo"
        title="Redo"
        onClick={props.onRedo}
      >
        <Redo2 size={16} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        className="kaava-markup__btn"
        aria-label="Clear"
        title="Clear"
        onClick={props.onClear}
      >
        <Trash2 size={16} strokeWidth={1.5} />
      </button>
      <span className="kaava-markup__sep" />
      <button type="button" className="kaava-markup__done" onClick={props.onDone}>
        <Check size={14} strokeWidth={1.5} />
        Done
      </button>
    </div>
  );
}
