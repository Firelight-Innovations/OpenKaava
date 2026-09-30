/**
 * Ink colours come from the design tokens (`src/tokens.css`), never from
 * literals in a component. Excalidraw stores colours as strings in the file, so
 * the tokens are resolved to hex when the layer mounts and whenever the theme
 * changes; an element keeps the colour it was drawn with.
 *
 * `FALLBACK` exists only for a document that has no tokens loaded (a test, a
 * bare harness). In the app every entry is overridden.
 */

export interface InkSwatch {
  id: string;
  label: string;
  token: string;
  color: string;
}

export interface InkPalette {
  swatches: InkSwatch[];
  /** Default ink. */
  ink: string;
  pinFill: string;
  pinStroke: string;
  pinText: string;
}

const SWATCH_TOKENS: { id: string; label: string; token: string; fallback: string }[] = [
  { id: "danger", label: "Red", token: "--danger", fallback: "#e5534b" },
  { id: "warning", label: "Amber", token: "--warning", fallback: "#e0a030" },
  { id: "success", label: "Green", token: "--success", fallback: "#4cb863" },
  { id: "accent", label: "Accent", token: "--accent", fallback: "#3f76ff" },
  { id: "violet", label: "Violet", token: "--accent-violet", fallback: "#a585f0" },
];

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const hex2 = (n: number) => clamp255(n).toString(16).padStart(2, "0");

/**
 * A CSS colour as `#rrggbb`, or null if it is not one of the forms a browser
 * reports for a computed colour: hex, `rgb()`/`rgba()` and `color(srgb r g b)`
 * (what Chrome returns for a `color-mix()` token).
 */
export function toHex(css: string): string | null {
  const s = css.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{8}$/.test(s)) return s.slice(0, 7);
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (rgb) return `#${hex2(+rgb[1])}${hex2(+rgb[2])}${hex2(+rgb[3])}`;
  const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s);
  if (srgb) return `#${hex2(+srgb[1] * 255)}${hex2(+srgb[2] * 255)}${hex2(+srgb[3] * 255)}`;
  return null;
}

/**
 * The palette for a resolver that maps a token name to a CSS colour string (or
 * undefined). Pure, so the mapping can be tested without a document.
 */
export function buildPalette(read: (token: string) => string | undefined): InkPalette {
  const pick = (token: string, fallback: string) => {
    const value = read(token);
    return (value ? toHex(value) : null) ?? fallback;
  };
  const swatches = SWATCH_TOKENS.map((s) => ({
    id: s.id,
    label: s.label,
    token: s.token,
    color: pick(s.token, s.fallback),
  }));
  const accent = pick("--accent", "#3f76ff");
  return {
    swatches,
    ink: swatches[0].color,
    pinFill: accent,
    pinStroke: accent,
    pinText: pick("--txt-on-accent", "#0f0f10"),
  };
}

/**
 * Resolves tokens against a live element. A probe child with `color: var(--x)`
 * is read back through `getComputedStyle`, because a custom property read
 * directly comes back unresolved when it is defined with `color-mix()`.
 */
export function readPalette(root: HTMLElement): InkPalette {
  const probe = document.createElement("span");
  probe.style.display = "none";
  root.appendChild(probe);
  try {
    const rootStyle = getComputedStyle(root);
    return buildPalette((token) => {
      // An undefined token would make the probe inherit the text colour.
      if (!rootStyle.getPropertyValue(token).trim()) return undefined;
      probe.style.color = "";
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    });
  } finally {
    root.removeChild(probe);
  }
}
