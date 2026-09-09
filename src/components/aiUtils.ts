/**
 * aiUtils — Adobe Illustrator (.ai) support for the QA module.
 *
 * Illustrator files saved with "Create PDF Compatible File" (the BMW studio
 * default) are valid PDFs: one PDF page per artboard. We therefore drive them
 * through pdf.js to get, per artboard:
 *
 *   - true artboard dimensions
 *   - a high-resolution render (used for the preview and for QR scanning)
 *   - the live vector copy (no OCR needed, so spell-check runs at 100% confidence)
 *   - the fill colour of every text run, so magenta placeholder copy is flagged
 *
 * The same content-stream reader is reused for AI/PDF smart objects embedded
 * inside PSD files.
 */

// The `legacy` build is deliberate: pdf.js's modern bundle calls very recent
// JS built-ins (Map.prototype.getOrInsertComputed among them) that the Chromium
// inside Electron may not ship yet — without it, page rendering and operator
// lists throw and every artboard comes back blank.
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { inflate, inflateRaw } from 'pako';
import { isMagentaCmyk, isMagentaRgb, type RgbColor } from './colorUtils';

// ============================================
// pdf.js bootstrap
// ============================================

type PdfjsLib = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfjsPromise: Promise<PdfjsLib> | null = null;

async function getPdfjs(): Promise<PdfjsLib> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return lib;
    });
  }
  return pdfjsPromise;
}

// ============================================
// Types
// ============================================

export interface AiArtboard {
  index: number;
  name: string;
  /** Artboard width in px (PDF points map 1:1 to Illustrator px). */
  width: number;
  height: number;
  /** Rendered artboard — kept for QR scanning / pixel sampling, then released. */
  canvas: HTMLCanvasElement | null;
  blob: Blob;
  /** Vector copy found on the artboard. */
  texts: string[];
  /** Text runs painted in magenta (#FF00FF) — i.e. untouched default values. */
  magentaTexts: string[];
  /**
   * True when magenta text was painted on the artboard. Independent of
   * `magentaTexts`, which stays empty when the glyphs cannot be read back.
   */
  hasMagentaText: boolean;
}

// ============================================
// Rendering
// ============================================

/** Target longest edge for artboard renders — enough for legible QR modules. */
const RENDER_TARGET_EDGE = 1800;
const MAX_RENDER_SCALE = 4;
const MIN_RENDER_SCALE = 1;

function renderScaleFor(width: number, height: number): number {
  const maxEdge = Math.max(width, height);
  if (maxEdge <= 0) return 1;
  const scale = RENDER_TARGET_EDGE / maxEdge;
  return Math.min(MAX_RENDER_SCALE, Math.max(MIN_RENDER_SCALE, scale));
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(new Blob([], { type: 'image/png' }));
      return;
    }
    canvas.toBlob(
      (blob) => resolve(blob || new Blob([], { type: 'image/png' })),
      'image/png'
    );
  });
}

/**
 * Build the preview blob at the artboard's own pixel size.
 *
 * Artboards are rendered well above their nominal size so QR modules stay
 * legible, but keeping a batch of oversized PNGs in memory is wasteful — the
 * preview is never shown larger than the artboard itself. Rendering the preview
 * at native size also keeps the reported asset size comparable with the PSD
 * pipeline, which renders artboards 1:1.
 */
async function previewBlobFor(
  render: HTMLCanvasElement,
  width: number,
  height: number
): Promise<Blob> {
  if (render.width <= width || width <= 0 || height <= 0) {
    return canvasToBlob(render);
  }

  const preview = document.createElement('canvas');
  preview.width = Math.max(1, Math.round(width));
  preview.height = Math.max(1, Math.round(height));

  const ctx = preview.getContext('2d');
  if (!ctx) return canvasToBlob(render);

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, preview.width, preview.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(render, 0, 0, render.width, render.height, 0, 0, preview.width, preview.height);

  return canvasToBlob(preview);
}

// ============================================
// Text + colour extraction from a pdf.js page
// ============================================

function hexToRgb(hex: string): RgbColor | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

function glyphsToString(glyphs: unknown): string {
  if (!Array.isArray(glyphs)) return '';
  let out = '';
  for (const glyph of glyphs) {
    if (typeof glyph === 'number') {
      // Kerning adjustment; a large negative value means a visual space.
      if (glyph < -100) out += ' ';
      continue;
    }
    if (glyph && typeof glyph === 'object') {
      const g = glyph as { unicode?: string; fontChar?: string };
      if (typeof g.unicode === 'string') out += g.unicode;
      else if (typeof g.fontChar === 'string') out += g.fontChar;
    }
  }
  return out;
}

/** What a page-level magenta scan found. */
export interface MagentaScan {
  /** True when magenta text was painted, whether or not it could be read. */
  found: boolean;
  /** Readable samples of that text, when the glyphs map back to characters. */
  samples: string[];
}

/**
 * Walk a page's operator list tracking the active colours, and report the text
 * drawn in magenta.
 *
 * pdf.js normalises every colour operator (rg / k / g / sc / scn) into
 * `setFillRGBColor` / `setStrokeRGBColor` carrying a single `#rrggbb` string,
 * so this reads whatever colour space Illustrator used.
 *
 * `found` is deliberately independent of `samples`: a subset font with a custom
 * encoding can leave glyphs with no usable unicode mapping, and a price like
 * "₹59,999*" would then decode to nothing. The artboard still has magenta text
 * on it, so it must still be flagged — we just cannot quote it.
 */
async function findMagentaTextOnPage(page: {
  getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
}, OPS: Record<string, number>): Promise<MagentaScan> {
  let opList: { fnArray: number[]; argsArray: unknown[][] };
  try {
    opList = await page.getOperatorList();
  } catch (err) {
    console.warn('Could not read AI operator list for colour analysis:', err);
    return { found: false, samples: [] };
  }

  const samples: string[] = [];
  let found = false;

  interface GraphicsState {
    fill: RgbColor | null;
    stroke: RgbColor | null;
    textRenderMode: number;
  }

  let state: GraphicsState = { fill: null, stroke: null, textRenderMode: 0 };
  const stack: GraphicsState[] = [];

  for (let i = 0; i < opList.fnArray.length; i++) {
    const op = opList.fnArray[i];
    const args = opList.argsArray[i];

    if (op === OPS.save) {
      stack.push({ ...state });
      continue;
    }
    if (op === OPS.restore) {
      const prev = stack.pop();
      if (prev) state = prev;
      continue;
    }
    if (op === OPS.setFillRGBColor) {
      const value = args?.[0];
      state.fill = typeof value === 'string' ? hexToRgb(value) : null;
      continue;
    }
    if (op === OPS.setStrokeRGBColor) {
      const value = args?.[0];
      state.stroke = typeof value === 'string' ? hexToRgb(value) : null;
      continue;
    }
    if (op === OPS.setFillTransparent) {
      state.fill = null;
      continue;
    }
    if (op === OPS.setTextRenderingMode) {
      const mode = args?.[0];
      state.textRenderMode = typeof mode === 'number' ? mode : 0;
      continue;
    }
    if (op === OPS.showText) {
      const mode = state.textRenderMode;
      // 3 = invisible, 7 = clip-only. Neither is visible placeholder copy.
      if (mode === 3 || mode === 7) continue;

      // Modes 0/2/4/6 paint the fill; 1/5 paint the stroke only.
      const paintsFill = mode !== 1 && mode !== 5;
      const paintsStroke = mode === 1 || mode === 2 || mode === 5 || mode === 6;

      const isMagenta =
        (paintsFill && isMagentaRgb(state.fill)) ||
        (paintsStroke && isMagentaRgb(state.stroke));
      if (!isMagenta) continue;

      found = true;

      const text = glyphsToString(args?.[0]).trim();
      if (text.length > 0) samples.push(text);
    }
  }

  return { found, samples: dedupe(samples) };
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => v.trim().length > 0)));
}

/**
 * Collect the readable copy on a page, preserving line breaks.
 */
async function extractPageText(page: {
  getTextContent: () => Promise<{ items: unknown[] }>;
}): Promise<string[]> {
  try {
    const content = await page.getTextContent();
    const lines: string[] = [];
    let current = '';

    for (const raw of content.items) {
      const item = raw as { str?: string; hasEOL?: boolean };
      if (typeof item.str !== 'string') continue;
      current += item.str;
      if (item.hasEOL) {
        const trimmed = current.trim();
        if (trimmed.length > 0) lines.push(trimmed);
        current = '';
      }
    }

    const tail = current.trim();
    if (tail.length > 0) lines.push(tail);

    return lines;
  } catch (err) {
    console.warn('Could not read AI page text content:', err);
    return [];
  }
}

// ============================================
// Public: parse an .ai document
// ============================================

export class AiParseError extends Error {}

/**
 * Read an Illustrator document and return one entry per artboard.
 *
 * Throws {@link AiParseError} when the file has no PDF-compatible stream — the
 * caller can then fall back to the embedded XMP thumbnail.
 */
export async function processAiDocument(
  file: File,
  onProgress?: (stage: string) => void
): Promise<AiArtboard[]> {
  onProgress?.('Loading Illustrator engine...');
  const pdfjsLib = await getPdfjs();
  const OPS = pdfjsLib.OPS as unknown as Record<string, number>;

  onProgress?.('Reading Illustrator file buffer...');
  const arrayBuffer = await file.arrayBuffer();

  let pdf: Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>;
  try {
    pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
      // Illustrator embeds its own private data; missing standard fonts should
      // never abort the parse.
      stopAtErrors: false,
    }).promise;
  } catch (err) {
    throw new AiParseError(
      `Illustrator file is not PDF-compatible (${err instanceof Error ? err.message : String(err)})`
    );
  }

  const doc = pdf as unknown as {
    numPages: number;
    getPageLabels: () => Promise<string[] | null>;
    getPage: (n: number) => Promise<any>;
    destroy?: () => Promise<void>;
    cleanup?: () => void;
  };

  let pageLabels: string[] | null = null;
  try {
    pageLabels = await doc.getPageLabels();
  } catch {
    pageLabels = null;
  }

  const artboards: AiArtboard[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    onProgress?.(`Rendering artboard ${pageNumber} of ${doc.numPages}...`);

    const page = await doc.getPage(pageNumber);

    const baseViewport = page.getViewport({ scale: 1 });
    const width = Math.round(baseViewport.width);
    const height = Math.round(baseViewport.height);

    const scale = renderScaleFor(width, height);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      // Illustrator artboards are transparent by default; QR scanning and the
      // preview both want an opaque white ground.
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      try {
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      } catch (err) {
        console.warn(`Could not render AI artboard ${pageNumber}:`, err);
      }
    }

    onProgress?.(`Reading text on artboard ${pageNumber} of ${doc.numPages}...`);
    const texts = await extractPageText(page);
    const magenta = await findMagentaTextOnPage(page, OPS);

    const blob = await previewBlobFor(canvas, width, height);

    artboards.push({
      index: pageNumber - 1,
      name: pageLabels?.[pageNumber - 1]?.trim() || `Artboard ${pageNumber}`,
      width,
      height,
      canvas,
      blob,
      texts,
      magentaTexts: magenta.samples,
      hasMagentaText: magenta.found,
    });

    page.cleanup?.();
  }

  try {
    await doc.destroy?.();
  } catch {
    // Nothing actionable if teardown fails.
  }

  if (artboards.length === 0) {
    throw new AiParseError('Illustrator file contains no readable artboards');
  }

  return artboards;
}

/**
 * Last-resort preview for .ai files saved without PDF compatibility: pull the
 * JPEG thumbnail Illustrator writes into the XMP packet.
 */
export async function extractAiXmpThumbnail(file: File): Promise<string | null> {
  try {
    const text = await file.text();
    const match = text.match(
      /<(?:xmpGImg|xapGImg):image[^>]*>([\s\S]*?)<\/(?:xmpGImg|xapGImg):image>/
    );
    if (!match || !match[1]) return null;

    const base64 = match[1]
      .replace(/&#x[A-F0-9]+;/gi, '')
      .replace(/\s/g, '')
      .replace(/[^A-Za-z0-9+/=]/g, '');

    return base64.length > 0 ? `data:image/jpeg;base64,${base64}` : null;
  } catch (err) {
    console.warn('XMP thumbnail extraction failed:', err);
    return null;
  }
}

// ============================================
// Raw PDF content-stream reader
// ============================================
// Used for AI/PDF smart objects embedded inside PSD files, where pdf.js cannot
// be pointed at a standalone document.

/** Unescape standard PDF string escapes. */
function unescapePdfString(s: string): string {
  return s
    .replace(/\\\\/g, '\\')
    .replace(/\\([()])/g, '$1')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

/** Decompress every content stream in a raw PDF/AI buffer. */
function decompressPdfStreams(data: Uint8Array): string[] {
  const str = new TextDecoder('latin1').decode(data);
  const streamRegex = /\/Length\s+(\d+)[\s\S]*?stream[\r\n]+/g;
  const streams: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = streamRegex.exec(str)) !== null) {
    const length = parseInt(match[1], 10);
    if (!length || length <= 0 || length > 20000000) continue;

    const streamStart = match.index + match[0].length;
    const slice = data.subarray(streamStart, streamStart + length);

    let decompressed = '';
    try {
      decompressed = new TextDecoder('latin1').decode(inflate(slice));
    } catch {
      try {
        decompressed = new TextDecoder('latin1').decode(inflateRaw(slice));
      } catch {
        try {
          decompressed = new TextDecoder('latin1').decode(slice);
        } catch {
          decompressed = '';
        }
      }
    }

    if (decompressed) streams.push(decompressed);
  }

  return streams;
}

/**
 * Keep printable marketing copy, drop binary font/glyph noise.
 *
 * The allowed set has to cover real ad copy, which includes prices and legal
 * marks — "₹59,999*" and "up to ₹1.5 Lakh*" were previously discarded as noise.
 */
function isPrintableCopy(text: string): boolean {
  return (
    text.length > 0 &&
    /^[a-zA-Z0-9\s.,!?:;'"“”\-–—/()&%*+@#°₹$€£¥~_[\]{}|=<>]+$/.test(text)
  );
}

/**
 * Sequentially scan a decompressed content stream for text painted in magenta.
 *
 * Illustrator writes colour with `r g b rg` (RGB documents) or `c m y k k`
 * (CMYK documents); separation/spot colours arrive via `scn`. All components
 * are 0..1 floats in a content stream.
 */
function findMagentaTextInStream(stream: string): string[] {
  const OP_RE =
    /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+k(?![a-zA-Z])|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+rg(?![a-zA-Z])|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+scn(?![a-zA-Z])|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+scn(?![a-zA-Z])|(-?[\d.]+)\s+g(?![a-zA-Z])|\[([\s\S]*?)\]\s*TJ(?![a-zA-Z])|\(((?:\\.|[^\\()])*)\)\s*Tj(?![a-zA-Z])/g;

  const found: string[] = [];
  // The stream carries the original ink values, so CMYK fills are judged in ink
  // space and only RGB fills go through the HSL anchors.
  let fillIsMagenta = false;
  let match: RegExpExecArray | null;

  const num = (v: string) => Math.max(0, Math.min(1, parseFloat(v)));
  const toByte = (v: string) => Math.round(num(v) * 255);
  const rgbFill = (r: string, g: string, b: string) =>
    isMagentaRgb({ r: toByte(r), g: toByte(g), b: toByte(b) } as RgbColor);

  while ((match = OP_RE.exec(stream)) !== null) {
    // CMYK: "c m y k k"
    if (match[1] !== undefined) {
      fillIsMagenta = isMagentaCmyk(num(match[1]), num(match[2]), num(match[3]), num(match[4]));
      continue;
    }

    // RGB: "r g b rg"
    if (match[5] !== undefined) {
      fillIsMagenta = rgbFill(match[5], match[6], match[7]);
      continue;
    }

    // scn with 4 components — treat as CMYK
    if (match[8] !== undefined) {
      fillIsMagenta = isMagentaCmyk(num(match[8]), num(match[9]), num(match[10]), num(match[11]));
      continue;
    }

    // scn with 3 components — treat as RGB
    if (match[12] !== undefined) {
      fillIsMagenta = rgbFill(match[12], match[13], match[14]);
      continue;
    }

    // Gray: "g g" — never magenta.
    if (match[15] !== undefined) {
      fillIsMagenta = false;
      continue;
    }

    if (!fillIsMagenta) continue;

    // TJ array
    if (match[16] !== undefined) {
      const strRegex = /\((?:\\.|[^\\()])*\)/g;
      let assembled = '';
      let sm: RegExpExecArray | null;
      while ((sm = strRegex.exec(match[16])) !== null) {
        assembled += unescapePdfString(sm[0].slice(1, -1));
      }
      assembled = assembled.trim();
      if (isPrintableCopy(assembled)) found.push(assembled);
      continue;
    }

    // Single Tj
    if (match[17] !== undefined) {
      const text = unescapePdfString(match[17]).trim();
      if (isPrintableCopy(text)) found.push(text);
    }
  }

  return found;
}

/**
 * Extract vector copy — and magenta placeholder copy — from an embedded
 * Illustrator (.ai) / PDF smart object buffer.
 */
export function extractTextFromPdfBuffer(data: Uint8Array): {
  texts: string[];
  magentaTexts: string[];
} {
  const streams = decompressPdfStreams(data);
  const texts: string[] = [];
  const magentaTexts: string[] = [];

  for (const stream of streams) {
    if (!stream.includes('BT')) continue;

    const btRegex = /BT([\s\S]*?)ET/g;
    let btMatch: RegExpExecArray | null;
    while ((btMatch = btRegex.exec(stream)) !== null) {
      const block = btMatch[1];

      // TJ arrays: [(...) num (...)] TJ
      const tjRegex = /\[([\s\S]*?)\]\s*TJ/g;
      let tjMatch: RegExpExecArray | null;
      while ((tjMatch = tjRegex.exec(block)) !== null) {
        const strRegex = /\(([^)]*)\)/g;
        let assembled = '';
        let sm: RegExpExecArray | null;
        while ((sm = strRegex.exec(tjMatch[1])) !== null) {
          assembled += unescapePdfString(sm[1]);
        }
        assembled = assembled.trim();
        if (assembled.length > 0) texts.push(assembled);
      }

      // Single Tj: (...) Tj
      const singleTjRegex = /\(([^)]*)\)\s*Tj/g;
      let sMatch: RegExpExecArray | null;
      while ((sMatch = singleTjRegex.exec(block)) !== null) {
        const t = unescapePdfString(sMatch[1]).trim();
        if (t.length > 0) texts.push(t);
      }
    }

    magentaTexts.push(...findMagentaTextInStream(stream));
  }

  return {
    texts: dedupe(texts.filter(isPrintableCopy)),
    magentaTexts: dedupe(magentaTexts),
  };
}
