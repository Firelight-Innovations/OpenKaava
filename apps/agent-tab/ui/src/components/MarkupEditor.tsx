import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { Pencil, Square, Type, Undo2, X } from "lucide-react";
import { strings } from "../strings";
import type { MarkupEditorProps } from "./types";
import "./markup.css";

type Tool = "pen" | "rect" | "text";
interface Point {
  x: number;
  y: number;
}
type Mark =
  | { tool: "pen"; points: Point[]; color: string; width: number }
  | { tool: "rect"; from: Point; to: Point; color: string; width: number }
  | { tool: "text"; at: Point; text: string; color: string; width: number };

const COLORS = ["#e5484d", "#f5cf73", "#4cc38a", "#3b82f6", "#ffffff"];
const WIDTHS = [3, 6, 12];

/** The editor's strokes are in the picture's own pixels, so they size to it. */
function draw(ctx: CanvasRenderingContext2D, marks: readonly Mark[]) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const mark of marks) {
    ctx.strokeStyle = mark.color;
    ctx.fillStyle = mark.color;
    ctx.lineWidth = mark.width;
    if (mark.tool === "pen") {
      ctx.beginPath();
      mark.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      if (mark.points.length === 1) ctx.lineTo(mark.points[0].x + 0.01, mark.points[0].y);
      ctx.stroke();
    } else if (mark.tool === "rect") {
      ctx.strokeRect(
        Math.min(mark.from.x, mark.to.x),
        Math.min(mark.from.y, mark.to.y),
        Math.abs(mark.to.x - mark.from.x),
        Math.abs(mark.to.y - mark.from.y),
      );
    } else {
      ctx.font = `600 ${mark.width * 6}px sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(mark.text, mark.at.x, mark.at.y);
    }
  }
}

/**
 * Draws over a pasted picture: pen, rectangle and text in a few colours and
 * widths, with undo. Save hands back the marked-up picture as a PNG; closing
 * leaves the original as it was.
 */
export function MarkupEditor({ src, onSave, onClose }: MarkupEditorProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const picture = useRef<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(WIDTHS[0]);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [live, setLive] = useState<Mark | null>(null);
  const [typing, setTyping] = useState<{ at: Point; box: Point; text: string } | null>(null);

  const paint = useCallback(() => {
    const el = canvas.current;
    const img = picture.current;
    const ctx = el?.getContext("2d");
    if (!el || !img || !ctx) return;
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.drawImage(img, 0, 0);
    draw(ctx, live ? [...marks, live] : marks);
  }, [marks, live]);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const el = canvas.current;
      if (!el) return;
      el.width = img.naturalWidth;
      el.height = img.naturalHeight;
      picture.current = img;
      paint();
    };
    img.src = src;
    // Loaded once; later redraws come from `paint`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(paint, [paint]);

  const at = (event: PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * event.currentTarget.width,
      y: ((event.clientY - rect.top) / rect.height) * event.currentTarget.height,
    };
  };

  const commitText = () => {
    if (typing && typing.text.trim() !== "")
      setMarks((now) => [...now, { tool: "text", at: typing.at, text: typing.text, color, width }]);
    setTyping(null);
  };

  const onDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (typing) commitText();
    const p = at(event);
    if (tool === "text") {
      const rect = event.currentTarget.getBoundingClientRect();
      setTyping({
        at: p,
        box: { x: event.clientX - rect.left, y: event.clientY - rect.top },
        text: "",
      });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setLive(
      tool === "pen" ? { tool, points: [p], color, width } : { tool, from: p, to: p, color, width },
    );
  };

  const onMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!live) return;
    const p = at(event);
    setLive(
      live.tool === "pen"
        ? { ...live, points: [...live.points, p] }
        : live.tool === "rect"
          ? { ...live, to: p }
          : live,
    );
  };

  const onUp = () => {
    if (live) setMarks((now) => [...now, live]);
    setLive(null);
  };

  const save = () => {
    const el = canvas.current;
    if (!el) return;
    const url = el.toDataURL("image/png");
    onSave("image/png", url.slice(url.indexOf(",") + 1));
  };

  const toolButton = (name: Tool, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      className="at-markup__tool"
      aria-label={label}
      title={label}
      aria-pressed={tool === name}
      onClick={() => setTool(name)}
    >
      {icon}
    </button>
  );

  return (
    <div className="at-markup" role="dialog" aria-modal="true" aria-label={strings.markup.title}>
      <div className="at-markup__stage">
        <canvas
          ref={canvas}
          className="at-markup__canvas"
          data-tool={tool}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
        {typing && (
          <input
            className="at-markup__text"
            autoFocus
            aria-label={strings.markup.text}
            style={{ left: typing.box.x, top: typing.box.y, color }}
            value={typing.text}
            onChange={(event) => setTyping({ ...typing, text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitText();
              if (event.key === "Escape") setTyping(null);
            }}
            onBlur={commitText}
          />
        )}
      </div>
      <div className="at-markup__bar" role="toolbar" aria-label={strings.markup.title}>
        {toolButton("pen", strings.markup.pen, <Pencil size={16} aria-hidden="true" />)}
        {toolButton("rect", strings.markup.rect, <Square size={16} aria-hidden="true" />)}
        {toolButton("text", strings.markup.text, <Type size={16} aria-hidden="true" />)}
        <span className="at-markup__sep" />
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className="at-markup__swatch"
            style={{ background: c }}
            aria-label={strings.markup.colour(c)}
            aria-pressed={color === c}
            onClick={() => setColor(c)}
          />
        ))}
        <span className="at-markup__sep" />
        {WIDTHS.map((w) => (
          <button
            key={w}
            type="button"
            className="at-markup__tool"
            aria-label={strings.markup.width(w)}
            aria-pressed={width === w}
            onClick={() => setWidth(w)}
          >
            <span className="at-markup__dash" style={{ height: w }} />
          </button>
        ))}
        <span className="at-markup__sep" />
        <button
          type="button"
          className="at-markup__tool"
          aria-label={strings.markup.undo}
          title={strings.markup.undo}
          disabled={marks.length === 0}
          onClick={() => setMarks((now) => now.slice(0, -1))}
        >
          <Undo2 size={16} aria-hidden="true" />
        </button>
        <button type="button" className="at-markup__save" onClick={save}>
          {strings.markup.save}
        </button>
        <button
          type="button"
          className="at-markup__tool"
          aria-label={strings.closeImage}
          title={strings.closeImage}
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
