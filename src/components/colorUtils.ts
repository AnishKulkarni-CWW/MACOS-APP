/**
 * colorUtils — colour normalisation + "default value" (magenta) detection.
 *
 * BMW master artwork uses pure magenta (#FF00FF) as the placeholder / default
 * text colour. Any copy still sitting in magenta has not been localised yet,
 * so the QA report surfaces it in the "Default Values" column.
 *
 *   HEX  #FF00FF
 *   RGB  (255, 0, 255)
 *   CMYK (0, 100, 0, 0)
 *   HSL  (300deg, 100%, 50%)
 */

export interface RgbColor {
  r: number; // 0-255
  g: number; // 0-255
  b: number; // 0-255
}

/**
 * Convert RGB (0-255) to HSL with hue in degrees, s/l in 0..1.
 */
export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;

  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  const l = (max + min) / 2;

  if (delta === 0) return { h: 0, s: 0, l };

  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);

  let h: number;
  if (max === rn) {
    h = ((gn - bn) / delta) % 6;
  } else if (max === gn) {
    h = (bn - rn) / delta + 2;
  } else {
    h = (rn - gn) / delta + 4;
  }
  h *= 60;
  if (h < 0) h += 360;

  return { h, s, l };
}

/**
 * Convert CMYK to RGB (0-255). Component values are expected in 0..1.
 */
export function cmykToRgb(c: number, m: number, y: number, k: number): RgbColor {
  return {
    r: Math.round(255 * (1 - Math.min(1, c)) * (1 - Math.min(1, k))),
    g: Math.round(255 * (1 - Math.min(1, m)) * (1 - Math.min(1, k))),
    b: Math.round(255 * (1 - Math.min(1, y)) * (1 - Math.min(1, k))),
  };
}

/**
 * Convert HSB/HSV to RGB (0-255). h in degrees, s/b in 0..1.
 */
export function hsbToRgb(h: number, s: number, v: number): RgbColor {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (h < 60) { rp = c; gp = x; }
  else if (h < 120) { rp = x; gp = c; }
  else if (h < 180) { gp = c; bp = x; }
  else if (h < 240) { gp = x; bp = c; }
  else if (h < 300) { rp = x; bp = c; }
  else { rp = c; bp = x; }

  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
  };
}

/**
 * Work out which numeric scale a set of colour components uses.
 * PSD/ag-psd stores 0-255, PDF content streams use 0-1, some descriptors use 0-100.
 */
function detectScale(values: number[]): number {
  const max = Math.max(...values.map((v) => Math.abs(v)));
  if (max <= 1.0001) return 1;
  if (max <= 100.0001) return 100;
  return 255;
}

/**
 * Normalise any colour shape produced by ag-psd (RGB / RGBA / FRGB / CMYK /
 * HSB / Grayscale) into plain 0-255 RGB. Returns null for shapes we cannot
 * reason about (e.g. LAB, or malformed values).
 */
export function normalizeColorToRgb(color: unknown): RgbColor | null {
  if (!color || typeof color !== 'object') return null;
  const c = color as Record<string, number>;

  // FRGB — floats 0..1
  if (typeof c.fr === 'number' && typeof c.fg === 'number' && typeof c.fb === 'number') {
    return {
      r: Math.round(Math.max(0, Math.min(1, c.fr)) * 255),
      g: Math.round(Math.max(0, Math.min(1, c.fg)) * 255),
      b: Math.round(Math.max(0, Math.min(1, c.fb)) * 255),
    };
  }

  // RGB / RGBA — ag-psd emits 0-255
  if (typeof c.r === 'number' && typeof c.g === 'number' && typeof c.b === 'number') {
    const scale = detectScale([c.r, c.g, c.b]);
    return {
      r: Math.round((c.r / scale) * 255),
      g: Math.round((c.g / scale) * 255),
      b: Math.round((c.b / scale) * 255),
    };
  }

  // CMYK
  if (
    typeof c.c === 'number' &&
    typeof c.m === 'number' &&
    typeof c.y === 'number' &&
    typeof c.k === 'number'
  ) {
    const scale = detectScale([c.c, c.m, c.y, c.k]);
    return cmykToRgb(c.c / scale, c.m / scale, c.y / scale, c.k / scale);
  }

  // HSB / HSV
  if (typeof c.h === 'number' && typeof c.s === 'number' && typeof c.b === 'number') {
    const sScale = detectScale([c.s, c.b]);
    return hsbToRgb(c.h, c.s / sScale, c.b / sScale);
  }

  // Grayscale — never magenta, but normalise anyway
  if (typeof c.k === 'number' && Object.keys(c).length === 1) {
    const scale = detectScale([c.k]);
    const v = Math.round(255 - (c.k / scale) * 255);
    return { r: v, g: v, b: v };
  }

  return null;
}

/**
 * An accepted rendering of "magenta", expressed as an HSL window.
 *
 * A literal `#FF00FF` test does not survive contact with real artwork. Two
 * conversions sit between the designer's colour picker and this code:
 * Illustrator converts on input (typing `#FF00FF` into a CMYK document stores a
 * magenta-dominant ink mix such as `17/91/0/0`), and pdf.js converts again on
 * output. Measured across that spread the results land anywhere between hue
 * 316° and 337° at saturations as low as 0.62 — and a spot magenta with an RGB
 * alternate lands at hue 324° / lightness 0.46.
 */
export interface MagentaAnchor {
  label: string;
  /** Centre hue in degrees. */
  hue: number;
  /** Allowed deviation from the centre hue. */
  hueTolerance: number;
  /** Minimum saturation, 0..1. */
  minSaturation: number;
  /** Allowed lightness window, 0..1. */
  minLightness: number;
  maxLightness: number;
}

/**
 * The window used for structured colour data — a PSD layer's colour, or the
 * fill pdf.js reports for an Illustrator object.
 *
 * Deliberately generous. Structured colour comes from artwork the designer
 * placed, so the realistic false positive is a brand colour that happens to be
 * magenta-ish; BMW's palette is blue, black, white and grey, so that risk is
 * near zero. Missing a placeholder because a colour profile shifted it a few
 * degrees is the far more expensive error.
 *
 * It still stops short of neighbouring families: crimson (hue 348) is out, so
 * are purples below saturation 0.45, and — importantly — a light magenta tint.
 * CMYK `0/50/0/0` renders at lightness 0.80, above the ceiling, so a 50% tint is
 * never mistaken for a full-strength placeholder.
 */
export const STRUCTURED_ANCHORS: MagentaAnchor[] = [
  {
    label: 'magenta family',
    hue: 316,
    hueTolerance: 28,
    minSaturation: 0.45,
    minLightness: 0.25,
    maxLightness: 0.78,
  },
];

/**
 * The window used to recognise *unmistakable* magenta in rendered pixels.
 *
 * Pixels are a much noisier signal than layer data — BMW artwork is full of
 * sunset photography whose pinks sit in the same hue range — so this pass only
 * accepts near-pure magenta on colour alone. Anything less certain has to prove
 * itself flat as well (see {@link scanCanvasForMagenta}).
 */
export const PIXEL_ANCHORS: MagentaAnchor[] = [
  {
    label: 'sRGB #FF00FF',
    hue: 300,
    hueTolerance: 10,
    minSaturation: 0.8,
    minLightness: 0.35,
    maxLightness: 0.65,
  },
  {
    label: 'CMYK magenta (converted)',
    hue: 328,
    hueTolerance: 8,
    minSaturation: 0.75,
    minLightness: 0.42,
    maxLightness: 0.66,
  },
];

/** Circular hue distance in degrees. */
export function hueDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
}

/**
 * Is this RGB triple magenta, under any of the supplied anchors?
 */
export function isMagentaRgb(
  rgb: RgbColor | null,
  anchors: MagentaAnchor[] = STRUCTURED_ANCHORS
): boolean {
  if (!rgb) return false;

  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);

  return anchors.some(
    (anchor) =>
      hueDistance(h, anchor.hue) <= anchor.hueTolerance &&
      s >= anchor.minSaturation &&
      l >= anchor.minLightness &&
      l <= anchor.maxLightness
  );
}

/** `#rrggbb` for an RGB triple. */
export function rgbToHex({ r, g, b }: RgbColor): string {
  const hex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * How far a colour sits from the magenta family, for reporting a near miss.
 * Returns null for colours that are not even in the neighbourhood.
 */
export function magentaProximity(rgb: RgbColor): number | null {
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  if (s < 0.25 || l < 0.15 || l > 0.9) return null;
  const distance = hueDistance(h, 316);
  return distance <= 45 ? distance : null;
}

/**
 * Is this ink mix magenta? Components are 0..1.
 *
 * When the original CMYK values survive — a raw AI/PDF content stream, a PSD
 * text layer stored in CMYK — judge in ink space rather than converting to RGB
 * first. "Magenta" then has an exact meaning (the magenta plate carries the
 * colour and the others are near-empty) instead of depending on whichever
 * CMYK-to-RGB approximation happens to be in play.
 */
export function isMagentaCmyk(c: number, m: number, y: number, k: number): boolean {
  if (m < 0.75) return false;      // must be a strong magenta plate
  if (y > 0.25) return false;      // yellow pushes it towards red
  if (k > 0.25) return false;      // black pushes it towards maroon
  if (c > 0.35) return false;      // cyan pushes it towards purple
  // And magenta has to actually dominate the other plates.
  return m - Math.max(c, y) >= 0.4;
}

/**
 * Is this colour (in any ag-psd colour shape) magenta?
 *
 * CMYK shapes are judged in ink space; everything else is normalised to RGB and
 * tested against the anchors.
 */
export function isMagentaColor(
  color: unknown,
  anchors: MagentaAnchor[] = STRUCTURED_ANCHORS
): boolean {
  if (color && typeof color === 'object') {
    const c = color as Record<string, number>;
    if (
      typeof c.c === 'number' &&
      typeof c.m === 'number' &&
      typeof c.y === 'number' &&
      typeof c.k === 'number'
    ) {
      const scale = detectScale([c.c, c.m, c.y, c.k]);
      return isMagentaCmyk(c.c / scale, c.m / scale, c.y / scale, c.k / scale);
    }
  }

  return isMagentaRgb(normalizeColorToRgb(color), anchors);
}

export interface MagentaPixelScan {
  found: boolean;
  /** Why it was flagged — or 'none'. */
  reason: 'pure' | 'flat-region' | 'none';
  /** Pixels of the dominant magenta-family colour (scaled back to full frame). */
  pixelCount: number;
  /**
   * The most-used colour from the magenta family on this canvas, whether or not
   * it was flagged. Reported so a near miss can be shown to the reviewer
   * instead of leaving them with an unexplained dash.
   */
  dominant: { rgb: RgbColor; count: number } | null;
}

const NO_PIXEL_MAGENTA: MagentaPixelScan = {
  found: false,
  reason: 'none',
  pixelCount: 0,
  dominant: null,
};

/**
 * Scan rendered pixels for placeholder magenta.
 *
 * This is the fallback for artwork whose colour cannot be read structurally —
 * a flattened raster, a gradient (pdf.js resolves those through a separate
 * pattern object), or type that a transparency flatten turned into an image.
 *
 * The hard part is that BMW campaign photography — sunsets especially — lives
 * in the same hue range as magenta, so colour alone cannot decide. Two passes
 * run instead:
 *
 *  1. **Pure** — pixels matching the tight {@link PIXEL_ANCHORS}. Near-pure
 *     magenta does not occur in natural light, so a small count is conclusive.
 *  2. **Flat region** — for the wider magenta family, pixels are counted per
 *     exact RGB value. A vector fill paints thousands of pixels of one identical
 *     value, with only anti-aliased edges around it; a photographic gradient
 *     spreads its pixels evenly across neighbouring values. Comparing the most
 *     common value against its immediate neighbours separates the two cleanly.
 */
export function scanCanvasForMagenta(
  canvas: HTMLCanvasElement,
  options: { minPurePixels?: number; minFlatPixels?: number; flatRatio?: number } = {}
): MagentaPixelScan {
  const minPurePixels = options.minPurePixels ?? 24;
  const minFlatPixels = options.minFlatPixels ?? 120;
  const flatRatio = options.flatRatio ?? 6;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || canvas.width === 0 || canvas.height === 0) return NO_PIXEL_MAGENTA;

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    // Tainted canvas (cross-origin source) — cannot sample.
    return NO_PIXEL_MAGENTA;
  }

  const totalPixels = canvas.width * canvas.height;
  const step = totalPixels > 4_000_000 ? 2 : 1;
  const scale = step; // sampled counts represent `step` real pixels each

  const histogram = new Map<number, number>();
  const HISTOGRAM_LIMIT = 250_000;

  for (let i = 0; i < data.length; i += 4 * step) {
    if (data[i + 3] < 128) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (!isMagentaRgb({ r, g, b }, STRUCTURED_ANCHORS)) continue;

    const key = (r << 16) | (g << 8) | b;
    const seen = histogram.get(key);
    if (seen !== undefined) histogram.set(key, seen + 1);
    else if (histogram.size < HISTOGRAM_LIMIT) histogram.set(key, 1);
  }

  const unpack = (key: number): RgbColor => ({
    r: (key >> 16) & 0xff,
    g: (key >> 8) & 0xff,
    b: key & 0xff,
  });

  /**
   * How far a value stands above the colours immediately surrounding it.
   *
   * The whole ±1 cube is checked, not one channel at a time: a ramp moves all
   * three channels together, so its neighbouring band sits at something like
   * (+1, +1, −1) and a single-axis probe would find nothing there and wrongly
   * call the band flat.
   */
  const isFlat = (key: number, count: number): boolean => {
    const { r, g, b } = unpack(key);
    let neighbourMax = 0;

    for (let dr = -1; dr <= 1; dr++) {
      const nr = r + dr;
      if (nr < 0 || nr > 255) continue;
      for (let dg = -1; dg <= 1; dg++) {
        const ng = g + dg;
        if (ng < 0 || ng > 255) continue;
        for (let db = -1; db <= 1; db++) {
          if (dr === 0 && dg === 0 && db === 0) continue;
          const nb = b + db;
          if (nb < 0 || nb > 255) continue;
          const neighbour = histogram.get((nr << 16) | (ng << 8) | nb) ?? 0;
          if (neighbour > neighbourMax) neighbourMax = neighbour;
        }
      }
    }

    return count > flatRatio * (neighbourMax + 1);
  };

  // Track the most-used family colour for reporting, and separately look for a
  // flat region. They are not the same thing: a photographic gradient can easily
  // out-count a small flat price, so scanning only the most common colour would
  // miss the placeholder sitting on top of it.
  let dominantKey = -1;
  let dominantCount = 0;
  let hit: { key: number; count: number; pure: boolean } | null = null;

  const smallestThreshold = Math.min(minPurePixels, minFlatPixels);

  for (const [key, count] of histogram) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantKey = key;
    }

    const realCount = count * scale;
    if (realCount < smallestThreshold) continue;

    // Flatness is required of pure magenta too. A gradient sweeping through the
    // magenta hues passes near-pure values for thousands of pixels, and colour
    // alone cannot tell that apart from a placeholder fill.
    if (!isFlat(key, count)) continue;

    const pure = isMagentaRgb(unpack(key), PIXEL_ANCHORS);
    if (realCount < (pure ? minPurePixels : minFlatPixels)) continue;

    if (!hit || count > hit.count) hit = { key, count, pure };
  }

  const dominant =
    dominantKey >= 0 ? { rgb: unpack(dominantKey), count: dominantCount * scale } : null;

  if (hit) {
    return {
      found: true,
      reason: hit.pure ? 'pure' : 'flat-region',
      pixelCount: hit.count * scale,
      dominant,
    };
  }

  return { found: false, reason: 'none', pixelCount: 0, dominant };
}

/**
 * Does this value look like a colour record?
 *
 * ag-psd represents colour as small plain objects and uses the same shapes
 * everywhere — text fills, layer effects, shape fills, strokes, gradient stops,
 * solid-colour fill layers. Recognising the shape means a scan finds colours
 * anywhere in a layer without having to enumerate every property that can hold
 * one.
 */
export function looksLikeColor(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;

  const num = (k: string) => typeof v[k] === 'number';
  const rgb = num('r') && num('g') && num('b');
  const frgb = num('fr') && num('fg') && num('fb');
  const cmyk = num('c') && num('m') && num('y') && num('k');
  const hsb = num('h') && num('s') && num('b');
  if (!rgb && !frgb && !cmyk && !hsb) return false;

  // Colour records are small; anything with a lot of other keys is a different
  // structure that happens to share a letter (bounds, transforms, and so on).
  return Object.keys(v).length <= 6;
}

/** Keys whose contents are pixels or structure, never a colour worth scanning. */
const UNSCANNABLE_KEYS = new Set([
  'canvas', 'imageData', 'image', 'thumbnail', 'data', 'children', 'mask',
  'layers', 'linkedFiles', 'imageResources', 'engineData',
]);

export interface MagentaHit {
  /** Dotted path to the colour inside the layer, e.g. "effects.stroke.0.color". */
  path: string;
  rgb: RgbColor;
}

export interface ObjectColorScan {
  hits: MagentaHit[];
  /** Closest magenta-family colour that did *not* qualify, for diagnostics. */
  nearest: RgbColor | null;
}

/**
 * Walk an arbitrary object graph and collect every magenta colour in it.
 *
 * Used to answer "is magenta used anywhere in this layer?" without depending on
 * a fixed list of properties — a magenta text fill, a magenta layer effect, a
 * magenta shape fill and a magenta gradient stop all surface the same way.
 */
export function scanObjectForMagenta(
  root: unknown,
  options: { maxDepth?: number; maxNodes?: number } = {}
): ObjectColorScan {
  const maxDepth = options.maxDepth ?? 8;
  const maxNodes = options.maxNodes ?? 20000;

  const hits: MagentaHit[] = [];
  let visited = 0;
  let nearest: RgbColor | null = null;
  let nearestDistance = Infinity;
  const seen = new Set<object>();

  const walk = (value: unknown, path: string, depth: number) => {
    if (depth > maxDepth || visited > maxNodes) return;
    if (!value || typeof value !== 'object') return;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;

    // Cycles are possible once linked files reference each other.
    if (seen.has(value as object)) return;
    seen.add(value as object);
    visited++;

    // A switched-off layer effect is not part of the delivered artwork.
    if ((value as Record<string, unknown>).enabled === false) return;
    if ((value as Record<string, unknown>).disabled === true) return;

    if (looksLikeColor(value)) {
      const rgb = normalizeColorToRgb(value);
      if (!rgb) return;

      if (isMagentaColor(value)) {
        hits.push({ path, rgb });
        return;
      }

      const distance = magentaProximity(rgb);
      if (distance !== null && distance < nearestDistance) {
        nearestDistance = distance;
        nearest = rgb;
      }
      return;
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length && visited <= maxNodes; i++) {
        walk(value[i], path ? `${path}.${i}` : String(i), depth + 1);
      }
      return;
    }

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (UNSCANNABLE_KEYS.has(key)) continue;
      walk(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };

  walk(root, '', 0);
  return { hits, nearest };
}
