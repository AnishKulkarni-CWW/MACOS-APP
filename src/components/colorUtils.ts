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
 * A single window is not enough: the same magenta reaches us through different
 * colour pipelines. Photoshop and RGB Illustrator documents give us sRGB
 * #FF00FF (hue 300), but pdf.js converts DeviceCMYK 0/100/0/0 with the
 * calibrated profile PDF viewers use, landing on #FB3199 (hue 329) — so a
 * CMYK Illustrator master would otherwise never be flagged.
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
 * Anchors used for structured colour data — a PSD text layer's fillColor, or an
 * AI/PDF fill operator. Those values are exact, so we allow only enough drift to
 * absorb colour-space conversion.
 *
 * The lightness ceilings matter: they are what separates a full-strength
 * magenta from a light tint (CMYK 0/50/0/0 renders at lightness 0.80).
 */
export const STRUCTURED_ANCHORS: MagentaAnchor[] = [
  {
    label: 'sRGB #FF00FF',
    hue: 300,
    hueTolerance: 12,
    minSaturation: 0.75,
    minLightness: 0.3,
    maxLightness: 0.72,
  },
  {
    label: 'DeviceCMYK 0/100/0/0',
    hue: 329,
    hueTolerance: 6,
    minSaturation: 0.8,
    minLightness: 0.5,
    maxLightness: 0.68,
  },
];

/**
 * Anchors used when sampling rendered pixels. Anti-aliasing and JPEG artefacts
 * smear edges, so these are tighter — only near-pure magenta counts, which keeps
 * pinks and purples that legitimately appear in artwork out of the report.
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
    label: 'DeviceCMYK 0/100/0/0',
    hue: 329,
    hueTolerance: 4,
    minSaturation: 0.88,
    minLightness: 0.54,
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
 * Is this colour (in any ag-psd colour shape) magenta?
 */
export function isMagentaColor(
  color: unknown,
  anchors: MagentaAnchor[] = STRUCTURED_ANCHORS
): boolean {
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
