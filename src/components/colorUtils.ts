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
 * One accepted rendering of "100% magenta", expressed as an HSL window.
 *
 * A single window is not enough, because the same magenta reaches us through
 * different colour pipelines:
 *
 *  - Photoshop text layers and RGB Illustrator documents give us sRGB #FF00FF
 *    (hue 300).
 *  - A CMYK Illustrator document does not. Typing #FF00FF into the colour
 *    picker of a CMYK document makes Illustrator convert it through the working
 *    profile, so what lands in the file is a magenta-dominant ink mix such as
 *    0/100/0/0, 8/98/0/0 or 17/91/0/0 — and pdf.js then converts *that* back to
 *    RGB with its DeviceCMYK approximation. Measured across that spread the
 *    results land between hue 316 and 337 at saturations as low as 0.62.
 *
 * The lightness ceilings are what separate a full-strength magenta from a light
 * tint: CMYK 0/50/0/0 renders at lightness 0.80 and must not be flagged.
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
 * Anchors for structured colour data — a PSD text layer's fillColor, or the
 * fill pdf.js reports for an Illustrator object.
 */
export const STRUCTURED_ANCHORS: MagentaAnchor[] = [
  {
    label: 'sRGB #FF00FF',
    hue: 300,
    hueTolerance: 14,
    minSaturation: 0.7,
    minLightness: 0.3,
    maxLightness: 0.72,
  },
  {
    // Covers every CMYK magenta measured through pdf.js: 0/100/0/0 -> #FB3199,
    // 17/91/0/0 -> #D341A0, 25/100/0/0 -> #C12D98, 0/100/20/0 -> #FD2F7F, and
    // spot magenta with an RGB alternate -> #EB008C.
    label: 'CMYK magenta (converted)',
    hue: 327,
    hueTolerance: 12,
    minSaturation: 0.6,
    minLightness: 0.4,
    maxLightness: 0.68,
  },
];

/**
 * Anchors for sampled pixels. Deliberately tighter than the structured windows:
 * this path only runs when no layer/vector colour was found, and BMW artwork is
 * full of sunset photography whose pinks would otherwise be mistaken for
 * placeholder copy.
 */
export const PIXEL_ANCHORS: MagentaAnchor[] = [
  {
    label: 'sRGB #FF00FF',
    hue: 300,
    hueTolerance: 8,
    minSaturation: 0.85,
    minLightness: 0.38,
    maxLightness: 0.62,
  },
  {
    label: 'CMYK magenta (converted)',
    hue: 328,
    hueTolerance: 6,
    minSaturation: 0.8,
    minLightness: 0.45,
    maxLightness: 0.64,
  },
];

/** Circular hue distance in degrees. */
function hueDistance(a: number, b: number): number {
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

/**
 * Scan rendered pixels for magenta. Used as a fallback when an asset carries no
 * structured text colour information (flattened rasters, rasterised artboards).
 *
 * Guarded on both sides:
 *  - at least `minPixels` magenta pixels, so single stray pixels are ignored
 *  - at most `maxCoverage` of the image, so a magenta background/graphic panel
 *    is not mistaken for placeholder copy
 */
export function scanCanvasForMagenta(
  canvas: HTMLCanvasElement,
  options: { minPixels?: number; maxCoverage?: number } = {}
): { found: boolean; pixelCount: number; coverage: number } {
  const minPixels = options.minPixels ?? 24;
  const maxCoverage = options.maxCoverage ?? 0.06;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || canvas.width === 0 || canvas.height === 0) {
    return { found: false, pixelCount: 0, coverage: 0 };
  }

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    // Tainted canvas (cross-origin source) — cannot sample.
    return { found: false, pixelCount: 0, coverage: 0 };
  }

  const totalPixels = canvas.width * canvas.height;
  // Sample every Nth pixel on large canvases to keep this fast on big batches.
  const step = totalPixels > 4_000_000 ? 4 : totalPixels > 1_000_000 ? 2 : 1;

  let count = 0;
  let sampled = 0;
  for (let i = 0; i < data.length; i += 4 * step) {
    const a = data[i + 3];
    if (a < 128) continue;
    sampled++;
    if (isMagentaRgb({ r: data[i], g: data[i + 1], b: data[i + 2] }, PIXEL_ANCHORS)) {
      count++;
    }
  }

  const scaledCount = count * step;
  const coverage = sampled > 0 ? count / sampled : 0;

  return {
    found: scaledCount >= minPixels && coverage <= maxCoverage,
    pixelCount: scaledCount,
    coverage,
  };
}
