/**
 * The Flap Ball design, drawn with `add_shapes`: four diagrams and an index.
 *
 * This is the worked example `docs/canvas-drawing-guide.md` points at, and
 * the canvas committed at `docs/canvas-examples/flap-ball.json` is this file
 * laid out with real font metrics. Every number shown comes from the value
 * table through `{{name}}`, so changing gravity is one `canvas/set-values`
 * call, not a hunt through labels.
 *
 * Rejected: a hand-drawn scene checked in as JSON alone. Nobody could review
 * or regenerate it, which is how the first attempt ended up with a caption cut
 * off at the frame edge and a note sitting on a pillar.
 */
import type { AddShapesSpec, Point, ShapeSpec } from "../layout";

/** The game's numbers, in world units (1 unit = 1 m) and seconds. */
export const FLAP_BALL_VALUES: Record<string, { value: number; unit?: string }> = {
  "field-width": { value: 9, unit: "u" },
  "field-height": { value: 16, unit: "u" },
  "floor-y": { value: 1.5, unit: "u" },
  "ball-radius": { value: 0.3, unit: "u" },
  "ball-x": { value: 2.25, unit: "u" },
  "ball-x-pct": { value: 25, unit: "%" },
  gravity: { value: 30, unit: "u/s²" },
  "flap-velocity": { value: 9, unit: "u/s" },
  "terminal-fall": { value: 16, unit: "u/s" },
  "pillar-width": { value: 1.4, unit: "u" },
  gap: { value: 3.6, unit: "u" },
  "gap-centre-min": { value: 5, unit: "u" },
  "gap-centre-max": { value: 12, unit: "u" },
  "gap-centre-step": { value: 4, unit: "u" },
  "pillar-speed": { value: 4, unit: "u/s" },
  "pillar-spacing": { value: 5.5, unit: "u" },
  "spawn-x": { value: 10.5, unit: "u" },
  "tap-interval": { value: 0.6, unit: "s" },
  "peak-rise": { value: 1.35, unit: "u" },
  "restart-delay": { value: 0.5, unit: "s" },
  "px-per-unit": { value: 30, unit: "px" },
};

const dim = (
  id: string,
  a: Point,
  b: Point,
  label: string,
  at: Point,
  align: ShapeSpec["align"] = "center",
): ShapeSpec[] => [
  { id, type: "line", points: [a, b], color: "muted", strokeWidth: 1, head: "bar", tail: "bar" },
  {
    id: `${id}-text`,
    type: "text",
    x: at[0],
    y: at[1],
    text: label,
    size: "small",
    color: "muted",
    align,
  },
];

/** 1. The playfield, to scale: 30 px per unit, y up from the bottom edge. */
function playfield(): AddShapesSpec {
  const U = 30;
  const X0 = 150;
  const TOP = 60;
  const px = (x: number) => X0 + x * U;
  const py = (y: number) => TOP + (16 - y) * U;
  const pillar = (id: string, centre: number, gapCentre: number, dashed: boolean): ShapeSpec[] => {
    const left = px(centre - 0.7);
    const gapTop = py(gapCentre + 1.8);
    const gapBottom = py(gapCentre - 1.8);
    return [
      {
        id: `${id}-top`,
        type: "rectangle",
        x: left,
        y: py(16),
        width: 1.4 * U,
        height: gapTop - py(16),
        color: "green",
        fill: dashed ? "none" : "green",
        dashed,
        rounded: false,
      },
      {
        id: `${id}-bottom`,
        type: "rectangle",
        x: left,
        y: gapBottom,
        width: 1.4 * U,
        height: py(1.5) - gapBottom,
        color: "green",
        fill: dashed ? "none" : "green",
        dashed,
        rounded: false,
      },
    ];
  };
  const r = 0.3 * U;
  const ballY = 8;
  return {
    frame: {
      id: "playfield",
      title: "Playfield, to scale",
      summary:
        "9 × 16 units, 30 px = 1 unit. The ball stays at a fixed x; the pillars and floor scroll left.",
      parent: "index",
      level: "subsystem",
      covers: ["physics", "spawning", "tuning"],
      x: 760,
      y: 0,
    },
    shapes: [
      {
        id: "field",
        type: "rectangle",
        x: px(0),
        y: py(16),
        width: 9 * U,
        height: 16 * U,
        color: "blue",
        rounded: false,
        strokeWidth: 2,
      },
      {
        id: "floor",
        type: "rectangle",
        x: px(0),
        y: py(1.5),
        width: 9 * U,
        height: 1.5 * U,
        color: "orange",
        fill: "orange",
        rounded: false,
      },
      ...pillar("p1", 5, 8, false),
      ...pillar("p2", 10.5, 11, true),
      {
        id: "ball",
        type: "ellipse",
        x: px(2.25) - r,
        y: py(ballY) - r,
        width: 2 * r,
        height: 2 * r,
        color: "red",
        fill: "solid",
      },
      {
        id: "flap",
        type: "arrow",
        points: [
          [px(2.25), py(ballY) - r - 4],
          [px(2.25), py(ballY) - r - 64],
        ],
        color: "blue",
      },
      {
        id: "flap-text",
        type: "text",
        x: px(2.25),
        y: py(ballY) - r - 70,
        align: "center",
        valign: "bottom",
        text: "flap: v = +{{flap-velocity}}",
        size: "small",
        color: "blue",
      },
      {
        id: "fall",
        type: "arrow",
        points: [
          [px(2.25), py(ballY) + r + 4],
          [px(2.25), py(ballY) + r + 64],
        ],
        color: "red",
      },
      {
        id: "fall-text",
        type: "text",
        x: px(2.25),
        y: py(ballY) + r + 70,
        align: "center",
        text: "gravity {{gravity}} u/s²\nmax fall {{terminal-fall}} u/s",
        size: "small",
        color: "red",
      },
      {
        id: "scroll",
        type: "arrow",
        points: [
          [px(8.4), 30],
          [px(5.6), 30],
        ],
        color: "green",
      },
      {
        id: "scroll-text",
        type: "text",
        x: px(8.6),
        y: 30,
        valign: "middle",
        text: "pillars move left {{pillar-speed}} u/s",
        size: "small",
        color: "green",
      },
      {
        id: "spawn-text",
        type: "text",
        x: px(11.3) + 8,
        y: py(8.5),
        text: "next pair spawns\nat centre x = {{spawn-x}}\n(off the right edge)",
        size: "small",
        color: "green",
      },
      {
        id: "ceiling-text",
        type: "text",
        x: px(0) - 8,
        y: py(16),
        align: "right",
        valign: "middle",
        text: "ceiling y = {{field-height}}",
        size: "small",
        color: "muted",
      },
      {
        id: "floor-text",
        type: "text",
        x: px(0) - 8,
        y: py(1.5),
        align: "right",
        valign: "middle",
        text: "floor y = {{floor-y}}",
        size: "small",
        color: "muted",
      },
      {
        id: "range",
        type: "line",
        points: [
          [px(0) - 30, py(12)],
          [px(0) - 30, py(5)],
        ],
        color: "violet",
        strokeWidth: 3,
        head: "bar",
        tail: "bar",
      },
      {
        id: "range-text",
        type: "text",
        x: px(0) - 40,
        y: py(8.5),
        align: "right",
        valign: "middle",
        text: "gap centre\n{{gap-centre-min}}–{{gap-centre-max}},\nwithin {{gap-centre-step}} of\nthe previous",
        size: "small",
        color: "violet",
      },
      ...dim(
        "gap-dim",
        [px(5.7) + 14, py(9.8)],
        [px(5.7) + 14, py(6.2)],
        "gap\n{{gap}}",
        [px(5.7) + 20, py(8)],
        "left",
      ),
      ...dim(
        "ballx-dim",
        [px(0), py(0) + 24],
        [px(2.25), py(0) + 24],
        "ball x = {{ball-x}} ({{ball-x-pct}}%)",
        [px(0), py(0) + 34],
        "left",
      ),
      ...dim("width-dim", [px(4.3), py(0) + 64], [px(5.7), py(0) + 64], "width {{pillar-width}}", [
        px(5),
        py(0) + 74,
      ]),
      ...dim(
        "spacing-dim",
        [px(5), py(0) + 104],
        [px(10.5), py(0) + 104],
        "{{pillar-spacing}} between pillar centres",
        [px(7.75), py(0) + 114],
      ),
    ],
  };
}

/** The ball's height after `t` seconds of one flap, in units. */
const arc = (t: number) => 9 * t - 15 * t * t;

/** 2. One run through a gap, drawn to scale at 60 px per unit. */
function runView(): AddShapesSpec {
  const U = 60;
  const X0 = 140;
  const LEVEL = 330;
  const tx = (t: number) => X0 + 4 * t * U;
  const hy = (h: number) => LEVEL - h * U;
  const flight: Point[] = [];
  for (let k = 0; k < 3; k++) {
    for (let i = k === 0 ? 0 : 1; i <= 12; i++) {
      const tau = i * 0.05;
      flight.push([tx(0.6 * k + tau), hy(arc(tau))]);
    }
  }
  const fall: Point[] = [];
  // The arc meets the floor (2.6 below level) at 15t² − 9t − 2.6 = 0.
  const landing = (9 + Math.sqrt(81 + 4 * 15 * 2.6)) / 30;
  for (let i = 12; i * 0.05 < landing; i++) fall.push([tx(1.2 + i * 0.05), hy(arc(i * 0.05))]);
  const ground = hy(-2.6);
  fall.push([tx(1.2 + landing), ground]);
  const centre = tx(1.0);
  const gapCentre = 0.7;
  const gapTop = hy(gapCentre + 1.8);
  const gapBottom = hy(gapCentre - 1.8);
  const taps = [0, 0.6, 1.2];
  return {
    frame: {
      id: "run",
      title: "A run through one gap",
      summary:
        "Side view to scale (60 px = 1 unit; time runs left to right at the pillar speed). A tap every 0.6 s keeps the ball level.",
      parent: "index",
      level: "subsystem",
      covers: ["input", "physics", "scoring", "tuning"],
    },
    shapes: [
      {
        id: "top",
        type: "rectangle",
        x: centre - 0.7 * U,
        y: 70,
        width: 1.4 * U,
        height: gapTop - 70,
        color: "green",
        fill: "green",
        rounded: false,
      },
      {
        id: "bottom",
        type: "rectangle",
        x: centre - 0.7 * U,
        y: gapBottom,
        width: 1.4 * U,
        height: ground - gapBottom,
        color: "green",
        fill: "green",
        rounded: false,
      },
      {
        id: "ground",
        type: "line",
        points: [
          [X0 - 20, ground],
          [tx(2.2), ground],
        ],
        color: "orange",
        strokeWidth: 3,
      },
      {
        id: "score-line",
        type: "line",
        points: [
          [centre, 50],
          [centre, ground],
        ],
        color: "violet",
        dashed: true,
        strokeWidth: 1,
      },
      {
        id: "score-text",
        type: "text",
        x: centre,
        y: 0,
        align: "center",
        text: "score +1 when the pillar centre\npasses the ball's x (once per pair)",
        size: "small",
        color: "violet",
      },
      { id: "flight", type: "line", points: flight, color: "blue", strokeWidth: 3 },
      { id: "no-tap", type: "arrow", points: fall, color: "red", dashed: true, strokeWidth: 2 },
      {
        id: "no-tap-text",
        type: "text",
        x: tx(1.2 + landing) + 12,
        y: ground - 60,
        text: "no tap = falls\n(hits the floor)",
        size: "small",
        color: "red",
      },
      {
        id: "ball",
        type: "ellipse",
        x: tx(0) - 0.3 * U,
        y: hy(0) - 0.3 * U,
        width: 0.6 * U,
        height: 0.6 * U,
        color: "red",
        fill: "solid",
      },
      ...taps.flatMap((t, i): ShapeSpec[] => [
        {
          id: `tap-${i}`,
          type: "text",
          x: tx(t),
          y: hy(0) + 24,
          align: "center",
          text: "tap",
          size: "small",
          color: "orange",
        },
      ]),
      ...dim(
        "peak",
        [X0 - 50, hy(0)],
        [X0 - 50, hy(1.35)],
        "+{{peak-rise}} u\nper tap",
        [X0 - 60, hy(0.7)],
        "right",
      ),
      {
        id: "axis",
        type: "arrow",
        points: [
          [X0, ground + 40],
          [tx(2.2), ground + 40],
        ],
        color: "muted",
        strokeWidth: 1,
      },
      ...[0, 0.6, 1.2, 1.8].map((t, i): ShapeSpec => ({
        id: `t-${i}`,
        type: "text",
        x: tx(t),
        y: ground + 50,
        align: "center",
        text: `${t} s`,
        size: "small",
        color: "muted",
      })),
      ...dim("interval", [tx(0), hy(0) + 60], [tx(0.6), hy(0) + 60], "{{tap-interval}} s", [
        tx(0.3),
        hy(0) + 70,
      ]),
      {
        id: "tuning",
        type: "text",
        x: tx(2.2) + 40,
        y: 90,
        text: "Tuning\ntoo hard: gap 4.2\nor gravity 24",
        size: "small",
        color: "muted",
      },
    ],
  };
}

/** 3. The game's states and what moves between them. */
function states(): AddShapesSpec {
  const box = (id: string, label: string, x: number, color: ShapeSpec["color"]): ShapeSpec => ({
    id,
    type: "rectangle",
    x,
    y: 40,
    width: 200,
    height: 70,
    label,
    size: "heading",
    color,
    fill: color,
  });
  const note = (id: string, x: number, text: string): ShapeSpec => ({
    id,
    type: "text",
    x,
    y: 150,
    text,
    size: "small",
    maxWidth: 220,
  });
  return {
    frame: {
      id: "states",
      title: "Game states",
      summary: "Ready → Playing → Dead, and Restart back to Ready once the 0.5 s guard has passed.",
      parent: "index",
      level: "subsystem",
      covers: ["states", "input", "ui", "audio"],
    },
    shapes: [
      // 240 between boxes so each arrow's label has room clear of its head;
      // the boxes start at 60 so the Restart loop stays inside the frame.
      box("ready", "Ready", 60, "blue"),
      box("playing", "Playing", 500, "green"),
      box("dead", "Dead", 940, "red"),
      {
        id: "start",
        type: "arrow",
        from: "ready",
        to: "playing",
        label: "first tap",
        color: "ink",
      },
      {
        id: "die",
        type: "arrow",
        from: "playing",
        to: "dead",
        label: "hit pillar,\nfloor or ceiling",
        color: "ink",
      },
      {
        id: "restart",
        type: "arrow",
        points: [
          [1146, 75],
          [1200, 75],
          [1200, 290],
          [20, 290],
          [20, 75],
          [54, 75],
        ],
        from: "dead",
        to: "ready",
        color: "ink",
      },
      {
        id: "restart-text",
        type: "text",
        x: 610,
        y: 300,
        align: "center",
        text: "Restart (ignored for the first {{restart-delay}} s)",
        size: "small",
      },
      note("ready-note", 60, "Ball bobs at y = 8.\nNo pillars.\nShows “Tap to start”."),
      note("playing-note", 500, "Gravity and spawning on.\nScore shown large,\ntop centre."),
      note(
        "dead-note",
        940,
        "Pillars freeze, ball drops\nto the floor, 0.2 s flash.\nGame Over panel:\nScore, Best (saved), Restart.",
      ),
      {
        id: "audio",
        type: "text",
        x: 0,
        y: 360,
        text: "Audio (optional): blip on flap · ding on score · thud on death",
        size: "small",
        color: "muted",
      },
    ],
  };
}

/** 4. The collision test, at 120 px per unit so the radius reads. */
function collision(): AddShapesSpec {
  const U = 120;
  const left = 260;
  const top = 20;
  const w = 1.4 * U;
  const bottom = top + 320;
  const r = 0.3 * U;
  const miss: Point = [left - 70, 110];
  const hit: Point = [left - 16, bottom + 20];
  const nearMiss: Point = [left, 110];
  const nearHit: Point = [left, bottom];
  return {
    frame: {
      id: "collision",
      title: "Collision: circle against rectangle",
      summary:
        "Clamp the ball's centre into the rectangle to get the nearest point P. The ball hits if the distance d from centre to P is less than r.",
      parent: "index",
      level: "detail",
      covers: ["physics"],
    },
    shapes: [
      {
        id: "pillar",
        type: "rectangle",
        x: left,
        y: top,
        width: w,
        height: bottom - top,
        color: "green",
        fill: "green",
        rounded: false,
        label: "pillar",
        size: "small",
      },
      {
        id: "miss-ball",
        type: "ellipse",
        x: miss[0] - r,
        y: miss[1] - r,
        width: 2 * r,
        height: 2 * r,
        color: "blue",
        dashed: true,
      },
      { id: "miss-d", type: "line", points: [miss, nearMiss], color: "blue", dashed: true },
      {
        id: "miss-p",
        type: "ellipse",
        x: nearMiss[0] - 4,
        y: nearMiss[1] - 4,
        width: 8,
        height: 8,
        color: "ink",
        fill: "solid",
      },
      {
        id: "miss-text",
        type: "text",
        x: miss[0] - r - 12,
        y: miss[1],
        align: "right",
        valign: "middle",
        text: "d > r: miss",
        size: "small",
        color: "blue",
      },
      {
        id: "hit-ball",
        type: "ellipse",
        x: hit[0] - r,
        y: hit[1] - r,
        width: 2 * r,
        height: 2 * r,
        color: "red",
        dashed: true,
      },
      {
        id: "hit-p",
        type: "ellipse",
        x: nearHit[0] - 4,
        y: nearHit[1] - 4,
        width: 8,
        height: 8,
        color: "ink",
        fill: "solid",
      },
      {
        id: "hit-text",
        type: "text",
        x: hit[0] - r - 12,
        y: hit[1],
        align: "right",
        valign: "middle",
        text: "d < r: hit",
        size: "small",
        color: "red",
      },
      { id: "hit-d", type: "line", points: [hit, nearHit], color: "red", dashed: true },
      {
        id: "miss-c",
        type: "ellipse",
        x: miss[0] - 3,
        y: miss[1] - 3,
        width: 6,
        height: 6,
        color: "blue",
        fill: "solid",
      },
      {
        id: "hit-c",
        type: "ellipse",
        x: hit[0] - 3,
        y: hit[1] - 3,
        width: 6,
        height: 6,
        color: "red",
        fill: "solid",
      },
      {
        id: "p-text",
        type: "text",
        x: left + 30,
        y: bottom + 24,
        text: "P: the nearest point\non the rectangle",
        size: "small",
      },
      {
        id: "rule",
        type: "text",
        x: left + w + 40,
        y: 60,
        text: "P = (clamp(cx, left, right),\n        clamp(cy, bottom, top))\nd = |C − P|\nhit if d < r   (r = {{ball-radius}})",
        size: "body",
      },
      {
        id: "also",
        type: "text",
        x: left + w + 40,
        y: 200,
        text: "The same test runs against\nthe floor and the ceiling.",
        size: "small",
        color: "muted",
      },
    ],
  };
}

/** The four diagrams, in the order they are laid out left to right. */
export function flapBallSpecs(): AddShapesSpec[] {
  return [playfield(), runView(), states(), collision()];
}
