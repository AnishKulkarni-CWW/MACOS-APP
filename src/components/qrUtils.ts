/**
 * qrUtils — QR code discovery inside rendered artwork plus link validation.
 *
 * Adobe Illustrator masters carry a QR code (usually a small vector block in a
 * corner) whose payload is the campaign landing page. QA needs to know two
 * things about that payload:
 *
 *   1. Is the link reachable, or is it broken?
 *   2. Does it point at an Indian destination (a `.in` domain / `in` host part)?
 *
 * Both answers are reported side by side in the QA table's "QR Links" column.
 */

import jsQR from 'jsqr';

export type LinkStatus = 'working' | 'broken' | 'unknown';

export interface QrLinkResult {
  /** Raw payload decoded out of the QR symbol. */
  raw: string;
  /** Payload normalised into an absolute URL (when it looks like one). */
  url: string;
  /** False when the QR encodes plain text rather than a link. */
  isUrl: boolean;
  /** Destination after following redirects, when known. */
  finalUrl?: string;
  httpStatus?: number;
  linkStatus: LinkStatus;
  /** True when the original or final URL resolves to an Indian host. */
  isIndian: boolean;
  error?: string;
}

export interface QrScanOutcome {
  /** True when the asset was actually scanned (i.e. we had pixels to look at). */
  scanned: boolean;
  links: QrLinkResult[];
}

// ============================================
// Canvas helpers
// ============================================

/** Longest edge we upscale small artwork to before decoding. */
const MIN_DECODE_EDGE = 1600;
/** Longest edge we downscale oversized artwork to before decoding. */
const MAX_DECODE_EDGE = 2200;
/** Longest edge a swept tile is upscaled to before decoding. */
const TILE_DECODE_EDGE = 700;

function drawToCanvas(
  source: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
  targetWidth: number,
  targetHeight: number
): HTMLCanvasElement | null {
  if (srcWidth <= 0 || srcHeight <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(targetWidth));
  canvas.height = Math.max(1, Math.round(targetHeight));

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  // QR finder patterns need a solid backdrop — transparent artwork otherwise
  // decodes as black-on-black.
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, srcWidth, srcHeight, 0, 0, canvas.width, canvas.height);

  return canvas;
}

/**
 * Produce a canvas sized into the sweet spot for jsQR decoding.
 */
function toDecodeCanvas(source: HTMLCanvasElement | HTMLImageElement): HTMLCanvasElement | null {
  const w = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const h = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  if (!w || !h) return null;

  const maxEdge = Math.max(w, h);
  let scale = 1;
  if (maxEdge < MIN_DECODE_EDGE) {
    scale = Math.min(4, MIN_DECODE_EDGE / maxEdge);
  } else if (maxEdge > MAX_DECODE_EDGE) {
    scale = MAX_DECODE_EDGE / maxEdge;
  }

  return drawToCanvas(source, w, h, w * scale, h * scale);
}

function decodeCanvas(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }

  const result = jsQR(imageData.data, canvas.width, canvas.height, {
    inversionAttempts: 'attemptBoth',
  });

  const value = result?.data?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * Re-draw a canvas with a hard black/white threshold. Helps when the QR sits on
 * a photographic background or has been printed in a tinted brand colour.
 */
function thresholdCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }

  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const outCtx = out.getContext('2d', { willReadFrequently: true });
  if (!outCtx) return null;

  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const v = luma > 140 ? 255 : 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  outCtx.putImageData(imageData, 0, 0);
  return out;
}

/**
 * Crop a region out of a canvas and upscale it so a physically small QR block
 * reaches a module size jsQR can lock onto.
 */
function cropAndUpscale(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number
): HTMLCanvasElement | null {
  if (w <= 0 || h <= 0) return null;

  const scale = Math.min(4, Math.max(1, TILE_DECODE_EDGE / Math.max(w, h)));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));

  const ctx = out.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, x, y, w, h, 0, 0, out.width, out.height);

  return out;
}

// ============================================
// QR detection
// ============================================

/**
 * Cheap reject for tiles that cannot contain a QR symbol.
 *
 * A QR needs high-contrast light and dark modules, so a flat tile (solid colour
 * panel, sky, a plain background) can be skipped for ~1% of the cost of asking
 * jsQR — and a large artboard is mostly such tiles.
 */
function hasDecodableContrast(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return true;

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    return true;
  }

  let min = 255;
  let max = 0;
  // Sample on a coarse stride — we only need the luminance range.
  for (let i = 0; i < data.length; i += 4 * 13) {
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (luma < min) min = luma;
    if (luma > max) max = luma;
    if (max - min >= 60) return true;
  }

  return max - min >= 60;
}

export interface QrDetectOptions {
  /**
   * Sweep the frame in overlapping tiles as well as whole-frame.
   * Needed for Illustrator masters, where the QR is often a small block in a
   * corner of a large artboard. Costs up to 25 extra decodes per artboard, so
   * it is off by default for bulk raster/PSD batches.
   */
  thorough?: boolean;
}

/**
 * Find every QR payload in a rendered artboard.
 *
 * jsQR only returns one symbol per pass, so a thorough scan sweeps the whole
 * frame first and then walks a tile grid — that also solves the common case of
 * a tiny QR tucked into the corner of a large banner.
 */
export function detectQrPayloads(
  source: HTMLCanvasElement | HTMLImageElement,
  options: QrDetectOptions = {}
): string[] {
  const base = toDecodeCanvas(source);
  if (!base) return [];

  const found = new Set<string>();

  // Pass 1 — whole frame. Catches QRs that dominate the artwork.
  const whole = decodeCanvas(base);
  if (whole) found.add(whole);

  if (!options.thorough) {
    return Array.from(found);
  }

  /**
   * Sweep a 5x5 grid of third-size tiles stepping by half a tile, so any QR up
   * to a third of the frame lands whole inside at least one tile regardless of
   * where it sits. `transform` optionally pre-processes each tile.
   */
  const sweep = (transform?: (tile: HTMLCanvasElement) => HTMLCanvasElement | null) => {
    const tileW = base.width / 3;
    const tileH = base.height / 3;
    const stepX = tileW / 2;
    const stepY = tileH / 2;

    for (let iy = 0; iy < 5; iy++) {
      for (let ix = 0; ix < 5; ix++) {
        const x = ix * stepX;
        const y = iy * stepY;
        const w = Math.min(tileW, base.width - x);
        const h = Math.min(tileH, base.height - y);
        if (w <= 8 || h <= 8) continue;

        const cropped = cropAndUpscale(base, x, y, w, h);
        if (!cropped) continue;
        if (!hasDecodableContrast(cropped)) continue;

        const tile = transform ? transform(cropped) : cropped;
        if (!tile) continue;

        const value = decodeCanvas(tile);
        if (value) found.add(value);
      }
    }
  };

  // Pass 2 — plain tile sweep. This is the pass that finds the small corner QR
  // Illustrator masters carry.
  sweep();

  // Passes 3 & 4 — only worth their cost when nothing has been found yet:
  // re-read the frame and the tiles with a hard black/white threshold, which
  // rescues low-contrast or tinted prints.
  if (found.size === 0) {
    const boosted = thresholdCanvas(base);
    if (boosted) {
      const value = decodeCanvas(boosted);
      if (value) found.add(value);
    }
  }

  if (found.size === 0) {
    sweep(thresholdCanvas);
  }

  return Array.from(found);
}

// ============================================
// Link inspection
// ============================================

/**
 * Turn a QR payload into an absolute URL when it looks like one.
 * QR codes frequently omit the scheme (`bmw.in/x1`), and may be wrapped in
 * `URL:` / `WEB:` prefixes by some generators.
 */
export function normalizeQrPayload(raw: string): { url: string; isUrl: boolean } {
  const trimmed = raw.trim().replace(/^(?:URL|URI|WEB)\s*:\s*/i, '');

  if (/^https?:\/\//i.test(trimmed)) {
    return { url: trimmed, isUrl: true };
  }

  // Anything with a scheme we cannot fetch (mailto:, tel:, geo:, WIFI:...)
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return { url: trimmed, isUrl: false };
  }

  // Bare domain / domain+path, e.g. "bmw.in/offers" or "www.bmw.co.in"
  if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#].*)?$/i.test(trimmed)) {
    return { url: `https://${trimmed}`, isUrl: true };
  }

  return { url: trimmed, isUrl: false };
}

/**
 * Does this URL point at an Indian destination?
 *
 * True for a `.in` TLD (`bmw.in`, `bmw.co.in`) and for an `in` host segment
 * used as a country subdomain (`in.bmw.com`).
 */
export function isIndianUrl(url: string): boolean {
  if (!url) return false;

  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    const match = url.toLowerCase().match(/^(?:[a-z]+:\/\/)?([^/?#:]+)/);
    host = match ? match[1] : '';
  }
  if (!host) return false;

  const parts = host.split('.').filter(Boolean);
  return parts.includes('in');
}

export interface UrlCheckResponse {
  ok: boolean;
  status?: number;
  finalUrl?: string;
  error?: string;
}

/** In-session cache so a shared landing page is only fetched once per batch. */
const linkCheckCache = new Map<string, Promise<UrlCheckResponse>>();

/**
 * Check whether a URL resolves. Runs through the Electron main process so the
 * request is not blocked by renderer CORS; degrades to "unknown" in a plain
 * browser where the status code cannot be read.
 */
export function checkUrl(url: string): Promise<UrlCheckResponse> {
  const cached = linkCheckCache.get(url);
  if (cached) return cached;

  const promise = (async (): Promise<UrlCheckResponse> => {
    const electronAPI = (window as unknown as { electronAPI?: { checkUrl?: (u: string) => Promise<UrlCheckResponse> } })
      .electronAPI;

    if (electronAPI?.checkUrl) {
      try {
        const result = await electronAPI.checkUrl(url);
        return result ?? { ok: false, error: 'No response from link checker' };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // Browser fallback — an opaque no-cors response tells us nothing about the
    // status, so a successful fetch is reported as indeterminate rather than
    // as a pass.
    try {
      await fetch(url, { method: 'HEAD', mode: 'no-cors' });
      return { ok: false, error: 'Link status unavailable outside the desktop app' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  })();

  linkCheckCache.set(url, promise);
  return promise;
}

/** Clears the per-batch link cache so a fresh analysis re-validates links. */
export function resetLinkCache(): void {
  linkCheckCache.clear();
}

/**
 * Evaluate a single decoded QR payload against both QA parameters.
 */
export async function evaluateQrPayload(raw: string): Promise<QrLinkResult> {
  const { url, isUrl } = normalizeQrPayload(raw);

  if (!isUrl) {
    return {
      raw,
      url,
      isUrl: false,
      linkStatus: 'unknown',
      isIndian: false,
      error: 'QR payload is not a web link',
    };
  }

  const check = await checkUrl(url);
  const finalUrl = check.finalUrl || url;

  let linkStatus: LinkStatus;
  if (check.ok) {
    linkStatus = 'working';
  } else if (typeof check.status === 'number') {
    // A response arrived, it was just an error status.
    linkStatus = 'broken';
  } else if (check.error && /unavailable outside the desktop app/i.test(check.error)) {
    linkStatus = 'unknown';
  } else {
    // DNS failure, TLS failure, timeout, connection refused.
    linkStatus = 'broken';
  }

  return {
    raw,
    url,
    isUrl: true,
    finalUrl: finalUrl !== url ? finalUrl : undefined,
    httpStatus: check.status,
    linkStatus,
    isIndian: isIndianUrl(url) || isIndianUrl(finalUrl),
    error: check.error,
  };
}

/**
 * Full QR pass for one rendered artboard: decode, then validate every payload.
 */
export async function analyzeQrCodes(
  source: HTMLCanvasElement | HTMLImageElement | null,
  options: QrDetectOptions = {}
): Promise<QrScanOutcome> {
  if (!source) return { scanned: false, links: [] };

  let payloads: string[] = [];
  try {
    payloads = detectQrPayloads(source, options);
  } catch (err) {
    console.warn('QR detection failed:', err);
    return { scanned: true, links: [] };
  }

  const links = await Promise.all(payloads.map((p) => evaluateQrPayload(p)));
  return { scanned: true, links };
}
