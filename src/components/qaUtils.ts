import JSZip from 'jszip';
import { readPsd, initializeCanvas } from 'ag-psd';
import type { Layer, Psd } from 'ag-psd';
import wordsText from '../assets/dictionary/en_words.txt?raw';
import {
  AiParseError,
  extractAiXmpThumbnail,
  extractTextFromPdfBuffer,
  processAiDocument,
} from './aiUtils';
import { findMagentaInObject, isMagentaColor, scanCanvasForMagenta } from './colorUtils';
import { analyzeQrCodes } from './qrUtils';
import type { QrScanOutcome } from './qrUtils';

export type { QrLinkResult, QrScanOutcome, LinkStatus } from './qrUtils';
export { resetLinkCache } from './qrUtils';

// Initialize canvas implementation for ag-psd if in browser
if (typeof document !== 'undefined') {
  try {
    initializeCanvas(
      (width: number, height: number) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
      },
      (width: number, height: number) => {
        const canvas = document.createElement('canvas');
        return canvas.getContext('2d')!.createImageData(width, height);
      }
    );
  } catch (e) {
    console.warn('ag-psd initializeCanvas setup note:', e);
  }
}

// ============================================
// Types
// ============================================

export interface ImageMetadata {
  fileName: string;
  width: number;
  height: number;
  aspectRatio: string;
  format: string;
  fileSize: number;
  fileSizeFormatted: string;
  lastModified: string;
  colorDepth: string;
}

export interface OCRResult {
  text: string;
  confidence: number;
  words: { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[];
}

export interface SpellingIssue {
  word: string;
  context: string;
}

/** Where an analysed asset came from — drives which QA columns are relevant. */
export type AssetSource = 'image' | 'psd' | 'ai';

/**
 * Result of the "Default Values" check: is anything on this artboard still in
 * the magenta (#FF00FF) placeholder colour?
 *
 * Magenta is searched for everywhere it can hide — text fills and strokes,
 * outlined type, shape fills, layer effects, gradient stops — because a
 * placeholder that survives as artwork rather than as live type is exactly as
 * much of a delivery defect.
 */
export interface DefaultValueCheck {
  hasMagenta: boolean;
  /** True when the magenta sits on type rather than only on artwork. */
  inText: boolean;
  /** What was found, so the reviewer knows what still needs localising. */
  samples: string[];
  /** How the verdict was reached. */
  method: 'layer' | 'vector' | 'pixel' | 'none';
}

export interface ImageAnalysis {
  id: string;
  fileName: string;
  previewUrl: string;
  sourceType: AssetSource;
  metadata: ImageMetadata;
  ocrResult: OCRResult;
  spellingIssues: SpellingIssue[];
  status: 'pass' | 'flagged' | 'no-text';
  /** QR codes found on the artboard and the verdict on each link. */
  qr: QrScanOutcome;
  defaultValues: DefaultValueCheck;
}

const EMPTY_DEFAULT_VALUES: DefaultValueCheck = {
  hasMagenta: false,
  inText: false,
  samples: [],
  method: 'none',
};

export interface ProcessingProgress {
  stage: 'reading' | 'metadata' | 'ocr' | 'spelling' | 'qr' | 'complete';
  stageLabel: string;
  current: number;
  total: number;
  percent: number;
}

// ============================================
// BMW-Specific Whitelist
// ============================================

const BMW_WHITELIST = new Set([
  // Models & Series
  'bmw', 'i3', 'i4', 'i5', 'i7', 'i8', 'ix', 'ix1', 'ix3', 'ix5',
  'm2', 'm3', 'm4', 'm5', 'm8', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7',
  'z4', 'z8',

  // Technologies & Features
  'xdrive', 'sdrive', 'edrive', 'idrive', 'twinpower', 'turbo',
  'valvetronic', 'vanos', 'steptronic', 'mpower', 'msport',
  'laserlight', 'skylounge', 'bimmercode', 'connected',
  'adas', 'hud', 'oled', 'phev', 'bev',

  // BMW Branding
  'sheerdriving', 'freude', 'fahrvergnügen',
  'alpina', 'motorsport', 'mperformance',

  // Dealer / Marketing
  'msrp', 'apr', 'oac', 'drl', 'led', 'lcd', 'suv', 'sav', 'sac',
  'coupe', 'coupé', 'sedan', 'roadster', 'convertible', 'gran',
  'tourer', 'grancoupe', 'granturismo',

  // Common abbreviations in ads
  'hp', 'mph', 'kw', 'nm', 'bhp', 'rpm', 'mpg', 'kwh',
  'awd', 'rwd', 'fwd', 'ev', 'suv',
  'co2', 'wltp', 'nedc',

  // Common marketing terms
  'rsvp', 'tnc', 'emi', 'gst', 'inr', 'usd', 'aud', 'sgd', 'myr',
  'hrs', 'min', 'km', 'kms',

  // URL/tech terms that may appear
  'www', 'com', 'http', 'https', 'html', 'url',

  // Common brand partners / terms
  'harman', 'kardon', 'bowers', 'wilkins', 'pirelli', 'michelin',
  'bridgestone', 'continental',

  // Contact-block abbreviations that appear in every dealer panel
  'tel', 'telephone', 'fax', 'mob', 'ext', 'ph', 'pvt', 'ltd', 'llp',
  'inc', 'opp', 'nr', 'rd', 'ave', 'blvd', 'marg', 'nagar', 'puram',

  // Indian currency & finance vocabulary used across BMW India pricing
  'lakh', 'lakhs', 'crore', 'crores', 'rupee', 'rupees', 'roi', 'tcs', 'tds',
  'onwards', 'ex', 'showroom',

  // Indian cities, states and the Mumbai localities BMW dealer panels list
  'india', 'mumbai', 'navi', 'worli', 'nariman', 'andheri', 'malad', 'bandra',
  'thane', 'powai', 'chembur', 'borivali', 'kurla', 'dadar', 'colaba',
  'delhi', 'gurgaon', 'gurugram', 'noida', 'bengaluru', 'bangalore',
  'chennai', 'hyderabad', 'kolkata', 'pune', 'ahmedabad', 'jaipur',
  'lucknow', 'chandigarh', 'kochi', 'surat', 'indore', 'nagpur',
  'coimbatore', 'vadodara', 'bhubaneswar', 'guwahati', 'goa', 'kerala',
  'punjab', 'haryana', 'gujarat', 'maharashtra', 'karnataka', 'telangana',

  // BMW India dealer groups
  'navnit', 'infinity', 'deutsche', 'motoren', 'bavaria', 'parsn', 'kun',

  // Marketing compounds that a plain lexicon misses
  'buyback', 'downpayment', 'roadside', 'testdrive', 'preowned',
]);

// ============================================
// English Dictionary (from macOS built-in)
// ============================================

const ENGLISH_DICTIONARY: Set<string> = new Set(
  wordsText
    .split('\n')
    .map((w: string) => w.trim().toLowerCase())
    .filter(Boolean)
);

// Also add very common words that might be missing from the filtered list
const EXTRA_COMMON = [
  'a', 'i', 'ok', 'an', 'am', 'is', 'it', 'in', 'on', 'to', 'do', 'go',
  'be', 'by', 'we', 'he', 'me', 'my', 'no', 'so', 'up', 'or', 'if', 'at',
  'of', 'as', 'us', 'vs', 'oh', 'hi', 'ha',
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'his', 'how', 'its', 'may',
  'new', 'now', 'old', 'see', 'way', 'who', 'did', 'get', 'let', 'say',
  'she', 'too', 'use',
];
for (const w of EXTRA_COMMON) {
  ENGLISH_DICTIONARY.add(w);
}

// ============================================
// Utility Functions
// ============================================

/**
 * Format bytes to human-readable size
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Calculate greatest common divisor
 */
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Calculate aspect ratio string from dimensions
 */
function calculateAspectRatio(width: number, height: number): string {
  const divisor = gcd(width, height);
  const ratioW = width / divisor;
  const ratioH = height / divisor;

  // Common ratio mappings for readability
  const knownRatios: Record<string, string> = {
    '16:9': '16:9', '9:16': '9:16',
    '4:3': '4:3', '3:4': '3:4',
    '3:2': '3:2', '2:3': '2:3',
    '1:1': '1:1',
    '21:9': '21:9', '9:21': '9:21',
  };

  const raw = `${ratioW}:${ratioH}`;
  if (knownRatios[raw]) return raw;

  // Approximate to nearest known ratio
  const ratio = width / height;
  if (Math.abs(ratio - 16 / 9) < 0.05) return '~16:9';
  if (Math.abs(ratio - 9 / 16) < 0.05) return '~9:16';
  if (Math.abs(ratio - 4 / 3) < 0.05) return '~4:3';
  if (Math.abs(ratio - 3 / 4) < 0.05) return '~3:4';
  if (Math.abs(ratio - 1) < 0.05) return '~1:1';

  return raw;
}

/**
 * Get file format from file name/type
 */
function getFileFormat(file: File | { name: string; type: string }): string {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const formatMap: Record<string, string> = {
    'jpg': 'JPEG',
    'jpeg': 'JPEG',
    'png': 'PNG',
    'gif': 'GIF',
    'webp': 'WebP',
    'bmp': 'BMP',
    'tiff': 'TIFF',
    'tif': 'TIFF',
    'svg': 'SVG',
  };
  return formatMap[ext] || ext.toUpperCase();
}

// ============================================
// Image Metadata Extraction
// ============================================

export function extractImageMetadata(
  file: File | { name: string; size: number; type: string; lastModified?: number },
  img: HTMLImageElement
): ImageMetadata {
  return {
    fileName: file.name,
    width: img.naturalWidth,
    height: img.naturalHeight,
    aspectRatio: calculateAspectRatio(img.naturalWidth, img.naturalHeight),
    format: getFileFormat(file as File),
    fileSize: file.size,
    fileSizeFormatted: formatFileSize(file.size),
    lastModified: file.lastModified
      ? new Date(file.lastModified).toLocaleString()
      : 'Unknown',
    colorDepth: '24-bit (RGB)', // Standard for JPEG/PNG in browser
  };
}

/**
 * Load image from a blob/file URL and return the HTMLImageElement
 */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = url;
  });
}

// ============================================
// OCR — Apple Vision Framework (macOS Native)
// ============================================
// Uses macOS built-in Vision framework via a compiled Swift binary.
// Runs 100% offline with far superior accuracy on photographic ads
// compared to Tesseract.js. Handles white-on-dark text, complex
// backgrounds, gradients, and small disclaimers natively.

/**
 * No-op init — native OCR doesn't need a worker.
 * Kept for API compatibility with the processing pipeline.
 */
export async function initOCRWorker(): Promise<void> {
  // Native OCR uses a compiled binary, no initialization needed.
}

/**
 * Run OCR on a single image using macOS Vision framework.
 * Sends the image buffer to the Electron main process, which runs
 * the compiled `ocr-vision` binary.
 *
 * Falls back gracefully if Electron API is unavailable (e.g., browser-only dev).
 */
export async function runOCR(imageSource: string | File | Blob): Promise<OCRResult> {
  let arrayBuffer: ArrayBuffer;
  let fileName = 'image.jpg';
  let blob: Blob;

  if (imageSource instanceof File) {
    blob = imageSource;
    fileName = imageSource.name;
  } else if (imageSource instanceof Blob) {
    blob = imageSource;
  } else {
    // It's a URL — fetch it as a blob first
    const response = await fetch(imageSource);
    blob = await response.blob();
  }

  // Pre-process: if image resolution is low (e.g. 300x250 banner), upscale it so fine text
  // reaches 24px+ height where Apple Vision OCR achieves near 100% accuracy.
  try {
    const objectUrl = URL.createObjectURL(blob);
    const img = await loadImage(objectUrl);
    URL.revokeObjectURL(objectUrl);

    const maxDim = Math.max(img.width, img.height);
    if (maxDim > 0 && maxDim < 1400) {
      const scale = Math.min(4, Math.max(1, Math.ceil(1600 / maxDim)));
      if (scale > 1) {
        const upCanvas = document.createElement('canvas');
        upCanvas.width = img.width * scale;
        upCanvas.height = img.height * scale;
        const ctx = upCanvas.getContext('2d');
        if (ctx) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, upCanvas.width, upCanvas.height);
          const upscaledBlob = await new Promise<Blob | null>((resolve) =>
            upCanvas.toBlob(resolve, 'image/jpeg', 0.95)
          );
          if (upscaledBlob) {
            blob = upscaledBlob;
          }
        }
      }
    }
  } catch (scaleErr) {
    console.warn('OCR image upscaling note:', scaleErr);
  }

  arrayBuffer = await blob.arrayBuffer();

  // Try native macOS OCR via Electron bridge
  const electronAPI = (window as any).electronAPI;
  if (electronAPI?.runNativeOCR) {
    try {
      const result = await electronAPI.runNativeOCR({
        buffer: Array.from(new Uint8Array(arrayBuffer)),
        fileName,
      });

      if (result?.success && result.lines) {
        const lines: { text: string; confidence: number }[] = result.lines;
        const fullText = lines.map((l) => l.text).join('\n');
        const avgConfidence =
          lines.length > 0
            ? (lines.reduce((sum, l) => sum + (l.confidence || 0), 0) / lines.length) * 100
            : 0;

        const words = lines.map((l) => ({
          text: l.text,
          confidence: (l.confidence || 0) * 100,
          bbox: { x0: 0, y0: 0, x1: 0, y1: 0 },
        }));

        return {
          text: fullText.trim(),
          confidence: Math.round(avgConfidence),
          words,
        };
      }

      // If native OCR returned an error, log and fall through to empty result
      console.warn('Native OCR returned error:', result?.error);
    } catch (err) {
      console.warn('Native OCR call failed, returning empty:', err);
    }
  } else {
    console.warn('Native OCR not available (not running in Electron)');
  }

  // If native OCR is unavailable, return empty result
  return { text: '', confidence: 0, words: [] };
}

/**
 * No-op terminate — native OCR uses a standalone binary, no worker to clean up.
 */
export async function terminateOCRWorker(): Promise<void> {
  // Nothing to terminate for native OCR.
}

// ============================================
// Spell Checking (Offline Dictionary)
// ============================================

/**
 * Tokenize text into words for spell checking
 */
function tokenize(text: string): { word: string; index: number }[] {
  const tokens: { word: string; index: number }[] = [];
  // Hyphens are separators, not part of a word. Keeping them inside the token
  // meant "state-of-the-art" was looked up whole (and always missed), and a
  // domain like "bmw-infinitycars" was reported as one misspelled word.
  const regex = /[a-zA-Z‘’']+/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    tokens.push({ word: match[0], index: match.index });
  }

  return tokens;
}

/**
 * Check if a word should be skipped (not spell-checked)
 */
function shouldSkipWord(word: string): boolean {
  // Skip very short words
  if (word.length <= 1) return true;

  // Skip words that are all uppercase abbreviations (e.g., BMW, MSRP)
  if (word === word.toUpperCase() && word.length <= 6) return true;

  // Skip words with numbers
  if (/\d/.test(word)) return true;

  // Skip words that look like measurements or codes
  if (/^[A-Z]{1,2}\d/.test(word)) return true;

  return false;
}

// --------------------------------------------
// Non-prose masking
// --------------------------------------------
// Dealer panels are the single biggest source of false spelling flags: they are
// nothing but proper nouns, abbreviations, phone numbers and URLs. None of that
// is prose, so none of it should reach the dictionary.

/** A web address or bare domain, with or without a scheme. */
const URL_PATTERN =
  /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|in|io|me|co|de|info|biz|edu|gov)\b\S*/gi;

/** An email address. */
const EMAIL_PATTERN = /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/gi;

/** A dialable number: at least 8 digits once separators are ignored. */
const PHONE_PATTERN = /\+?\d[\d\s().-]{6,}\d/;

/**
 * Does this line carry contact data rather than copy?
 */
function isContactLine(line: string): boolean {
  URL_PATTERN.lastIndex = 0;
  EMAIL_PATTERN.lastIndex = 0;
  return URL_PATTERN.test(line) || EMAIL_PATTERN.test(line) || PHONE_PATTERN.test(line);
}

/**
 * Is this a short label line made of proper names?
 *
 * Dealer panels are laid out as stacked labels — "Worli", "Nariman Point",
 * "BMW Infinity Cars", "BMW Navnit Motors Andheri" — which no general
 * dictionary will ever contain. They are recognised by shape rather than by
 * listing every Indian locality:
 *
 *   - at most five words, which covers the longest dealer lines
 *     ("BMW Infinity Cars Nariman Point") without reaching running copy;
 *   - every word Title-Case or ALL-CAPS, so a single lowercase word ("with",
 *     "at", "up") marks the line as prose and keeps it checked;
 *   - at least one Title-Case word, so ALL-CAPS headlines stay checked;
 *   - no sentence-ending punctuation, which again marks prose.
 *
 * The trade-off is deliberate: a short Title-Case line such as "Sheer Driving
 * Pleasure" is treated as a name and skipped. Those lines are brand lockups in
 * practice, and letting a dealer panel spray a dozen false flags over every
 * report costs far more than the rare missed typo in one.
 */
function isProperNameLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;

  // Sentence punctuation means prose.
  if (/[.!?]["'’)\]]*$/.test(trimmed)) return false;

  const words = trimmed.match(/[A-Za-z][A-Za-z‘’']*/g);
  if (!words || words.length === 0 || words.length > 5) return false;

  let titleCase = 0;
  for (const word of words) {
    const isTitle = /^[A-Z][a-z‘’']+$/.test(word);
    const isAllCaps = /^[A-Z]+$/.test(word);
    if (!isTitle && !isAllCaps) return false;
    if (isTitle) titleCase++;
  }

  return titleCase > 0;
}

/**
 * Blank out everything that is not prose, replacing it with spaces.
 *
 * Masking rather than deleting keeps every character index identical to the
 * original text, so the context shown next to a flagged word stays accurate.
 */
function maskNonProse(text: string): string {
  const blank = (match: string) => ' '.repeat(match.length);

  return text
    .split('\n')
    .map((line) => {
      if (isContactLine(line) || isProperNameLine(line)) {
        return ' '.repeat(line.length);
      }
      return line.replace(URL_PATTERN, blank).replace(EMAIL_PATTERN, blank);
    })
    .join('\n');
}

/**
 * Get surrounding context for a word in text
 */
function getWordContext(text: string, index: number, word: string): string {
  const contextRadius = 30;
  const start = Math.max(0, index - contextRadius);
  const end = Math.min(text.length, index + word.length + contextRadius);
  let context = text.substring(start, end).replace(/\n/g, ' ').trim();
  if (start > 0) context = '...' + context;
  if (end < text.length) context = context + '...';
  return context;
}

/**
 * Check spelling of extracted text.
 * Returns array of misspelled words with context.
 */
export function checkSpelling(text: string): SpellingIssue[] {
  if (!text || text.trim().length === 0) return [];

  const tokens = tokenize(maskNonProse(text));
  const issues: SpellingIssue[] = [];
  const alreadyFlagged = new Set<string>();

  for (const { word, index } of tokens) {
    if (shouldSkipWord(word)) continue;

    const lower = word.toLowerCase();

    // Strip leading/trailing apostrophes
    const cleaned = lower.replace(/^['']+|['']+$/g, '');
    if (cleaned.length <= 1) continue;

    // Check BMW whitelist first
    if (BMW_WHITELIST.has(cleaned)) continue;

    // Check English dictionary
    if (ENGLISH_DICTIONARY.has(cleaned)) continue;

    // Check common suffixed forms (comprehensive stemming)
    const stems = [
      cleaned.replace(/s$/, ''),           // cars → car
      cleaned.replace(/es$/, ''),          // boxes → box
      cleaned.replace(/ed$/, ''),          // jumped → jump
      cleaned.replace(/d$/, ''),           // illustrated → illustrate
      cleaned.replace(/ing$/, ''),         // running → runn (may not match, but try)
      cleaned.replace(/ing$/, 'e'),        // illustrating → illustrate
      cleaned.replace(/ly$/, ''),          // quickly → quick
      cleaned.replace(/er$/, ''),          // faster → fast
      cleaned.replace(/er$/, 'e'),         // wider → wide
      cleaned.replace(/est$/, ''),         // fastest → fast
      cleaned.replace(/est$/, 'e'),        // widest → wide
      cleaned.replace(/tion$/, 'te'),      // illustration → illustrate
      cleaned.replace(/tion$/, 't'),       // action → act
      cleaned.replace(/tion$/, ''),        // configuration → configura? (no, handle via -ation)
      cleaned.replace(/ation$/, 'e'),      // configuration → configure
      cleaned.replace(/ation$/, ''),       // admiration → admir
      cleaned.replace(/ment$/, ''),        // equipment → equip
      cleaned.replace(/ness$/, ''),        // darkness → dark
      cleaned.replace(/ies$/, 'y'),        // bodies → body
      cleaned.replace(/ied$/, 'y'),        // carried → carry
      cleaned.replace(/able$/, ''),        // comfortable → comfort
      cleaned.replace(/ible$/, ''),        // possible → poss (won't match, but 'possible' is in dict directly)
      cleaned.replace(/ous$/, ''),         // dangerous → danger (approx)
      cleaned.replace(/ful$/, ''),         // beautiful → beauti
      cleaned.replace(/less$/, ''),        // careless → care
      cleaned.replace(/ting$/, 'te'),      // illustrating → illustrate
      cleaned.replace(/ting$/, 't'),       // getting → get
      cleaned.replace(/led$/, 'le'),       // handled → handle
      cleaned.replace(/ted$/, 'te'),       // illustrated → illustrate
      cleaned.replace(/ted$/, 't'),        // conducted → conduct
      cleaned.replace(/ded$/, 'de'),       // provided → provide
      cleaned.replace(/sed$/, 'se'),       // advertised → advertise
      cleaned.replace(/zed$/, 'ze'),       // organized → organize
      cleaned.replace(/ally$/, 'al'),      // basically → basic (approx)
      cleaned.replace(/ily$/, 'y'),        // happily → happy
      cleaned.replace(/lied$/, 'ly'),      // supplied → supply
      cleaned.replace(/ied$/, 'ie'),       // died → die
      cleaned.replace(/ier$/, 'y'),        // happier → happy
      cleaned.replace(/iers$/, 'y'),       // suppliers → supply (approx)
      cleaned.replace(/'s$/, ''),          // possessive: car's → car
      cleaned.replace(/\u2019s$/, ''),     // curly quote possessive
    ];

    let foundViaStem = false;
    for (const stem of stems) {
      if (stem !== cleaned && stem.length > 1 && ENGLISH_DICTIONARY.has(stem)) {
        foundViaStem = true;
        break;
      }
    }
    if (foundViaStem) continue;

    // Deduplicate: don't flag the same word twice
    if (alreadyFlagged.has(cleaned)) continue;
    alreadyFlagged.add(cleaned);

    issues.push({
      word: word,
      context: getWordContext(text, index, word),
    });
  }

  return issues;
}

// ============================================
// Supported inputs
// ============================================

/** Every asset extension the QA module can analyse. */
export const SUPPORTED_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif',
  '.psd', '.ai',
];

/** Lower-cased extension including the leading dot, or '' when there is none. */
export function fileExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx === -1 ? '' : name.slice(idx).toLowerCase();
}

export function isPsdFile(name: string): boolean {
  return fileExtension(name) === '.psd';
}

export function isAiFile(name: string): boolean {
  return fileExtension(name) === '.ai';
}

export function isZipFile(name: string): boolean {
  return fileExtension(name) === '.zip';
}

export function isSupportedAsset(name: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(fileExtension(name));
}

// ============================================
// ZIP Processing
// ============================================

interface ExtractedImage {
  name: string;
  blob: Blob;
  file: File;
}

/**
 * Extract image files from a ZIP archive.
 * Returns an array of File objects for each image found.
 */
export async function processZipFile(zipFile: File): Promise<ExtractedImage[]> {
  const arrayBuffer = await zipFile.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const images: ExtractedImage[] = [];

  const entries = Object.entries(zip.files);

  for (const [path, zipEntry] of entries) {
    // Skip directories and hidden files (macOS __MACOSX folder)
    if (zipEntry.dir) continue;
    if (path.startsWith('__MACOSX') || path.startsWith('.')) continue;

    const ext = fileExtension(path);
    if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;

    const blob = await zipEntry.async('blob');
    const fileName = path.split('/').pop() || path;

    // Determine MIME type
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png', '.gif': 'image/gif',
      '.webp': 'image/webp', '.bmp': 'image/bmp',
      '.tiff': 'image/tiff', '.tif': 'image/tiff',
      '.psd': 'image/vnd.adobe.photoshop',
      '.ai': 'application/illustrator',
    };
    const mime = mimeMap[ext] || 'image/jpeg';

    const file = new File([blob], fileName, {
      type: mime,
      lastModified: zipEntry.date?.getTime() || Date.now(),
    });

    images.push({ name: fileName, blob, file });
  }

  return images;
}

// ============================================
// Full Analysis Pipeline
// ============================================

/**
 * Analyze a single image file: metadata + OCR + spell check.
 */
export async function analyzeImage(
  file: File,
  onProgress?: (stage: string) => void
): Promise<ImageAnalysis> {
  const id = `img-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

  // Create preview URL
  const previewUrl = URL.createObjectURL(file);

  // 1. Extract metadata
  onProgress?.('Extracting metadata...');
  const img = await loadImage(previewUrl);
  const metadata = extractImageMetadata(file, img);

  // 2. Run OCR
  onProgress?.('Running OCR analysis...');
  let ocrResult: OCRResult;
  try {
    ocrResult = await runOCR(previewUrl);
  } catch (err) {
    console.warn('OCR failed for', file.name, err);
    ocrResult = { text: '', confidence: 0, words: [] };
  }

  // 3. Check spelling
  onProgress?.('Checking spelling...');
  const spellingIssues = checkSpelling(ocrResult.text);

  // 4. QR codes — a flat raster has no vector data, so a single whole-frame
  //    sweep is enough; the thorough tile sweep is reserved for AI artboards.
  onProgress?.('Scanning for QR codes...');
  let qr: QrScanOutcome = { scanned: false, links: [] };
  try {
    qr = await analyzeQrCodes(img);
  } catch (err) {
    console.warn('QR scan failed for', file.name, err);
  }

  // 5. Default values — no layer data on a raster, so sample rendered pixels.
  const defaultValues = detectMagentaInImage(img);

  // Determine status
  let status: ImageAnalysis['status'] = 'pass';
  if (!ocrResult.text || ocrResult.text.trim().length === 0) {
    status = 'no-text';
  } else if (spellingIssues.length > 0) {
    status = 'flagged';
  }

  return {
    id,
    fileName: file.name,
    previewUrl,
    sourceType: 'image',
    metadata,
    ocrResult,
    spellingIssues,
    status,
    qr,
    defaultValues,
  };
}

/**
 * Pixel fallback for the "Default Values" check on assets that carry no
 * structured text colour (flat JPEG/PNG deliverables).
 */
function detectMagentaInImage(img: HTMLImageElement): DefaultValueCheck {
  try {
    const maxEdge = Math.max(img.naturalWidth, img.naturalHeight);
    if (maxEdge === 0) return EMPTY_DEFAULT_VALUES;

    // Cap the sample surface — spotting a colour does not need full resolution,
    // and a large deliverable would otherwise pin tens of megabytes per asset.
    const scale = Math.min(1, 1600 / maxEdge);

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return EMPTY_DEFAULT_VALUES;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const result = scanCanvasForMagenta(canvas);
    return result.found
      ? { hasMagenta: true, inText: false, samples: [], method: 'pixel' }
      : EMPTY_DEFAULT_VALUES;
  } catch (err) {
    console.warn('Magenta pixel scan failed:', err);
    return EMPTY_DEFAULT_VALUES;
  }
}

// ============================================
// PSD & Artboards Processing
// ============================================

interface ArtboardInfo {
  name: string;
  width: number;
  height: number;
  rect?: { top: number; left: number; bottom: number; right: number };
  children: Layer[];
}

/** What one pass over a PSD layer tree produced. */
interface LayerTextHarvest {
  texts: string[];
  /** Magenta copy, quoted from the text layers it was found on. */
  magentaTexts: string[];
  /** Layers whose artwork (not type) uses magenta, described for the report. */
  magentaLayers: string[];
}

/**
 * Every property of a layer that is not its type, its pixels or its children.
 *
 * Scanning this rather than the whole layer keeps the search away from image
 * data while still reaching shape fills, strokes, layer effects, gradient
 * stops, solid-colour fill layers and anything else ag-psd decodes — which is
 * what "magenta anywhere in the layer" actually requires.
 */
function magentaArtworkInLayer(layer: Layer): boolean {
  const { text, canvas, imageData, children, mask, ...rest } =
    layer as Layer & Record<string, unknown>;
  void text;
  void canvas;
  void imageData;
  void children;
  void mask;

  return findMagentaInObject(rest).length > 0;
}

/** A readable name for a layer, for reporting where magenta was found. */
function describeLayer(layer: Layer, index: number): string {
  const name = layer.name?.trim();
  return name && name.length > 0 ? name : `Layer ${index + 1}`;
}

/**
 * Collect the magenta-coloured runs of a native Photoshop text layer.
 *
 * Photoshop stores a base style plus optional per-range style runs, so a single
 * text layer can mix localised copy with an untouched magenta placeholder. We
 * walk the runs to return only the offending substrings.
 */
function magentaTextFromPsdLayer(layer: Layer): string[] {
  const data = layer.text;
  if (!data || typeof data.text !== 'string') return [];

  const full = data.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const baseFill = data.style?.fillColor;
  const runs = data.styleRuns;
  const out: string[] = [];

  if (runs && runs.length > 0) {
    let offset = 0;
    for (const run of runs) {
      const length = run.length ?? 0;
      const slice = full.slice(offset, offset + length);
      offset += length;

      const fill = run.style?.fillColor ?? baseFill;
      if (fill && isMagentaColor(fill)) {
        const trimmed = slice.trim();
        if (trimmed.length > 0) out.push(trimmed);
      }
    }
    return out;
  }

  if (baseFill && isMagentaColor(baseFill)) {
    const trimmed = full.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }

  return out;
}

/**
 * Recursively extract all text strings from PSD layer hierarchy,
 * inspecting both native Photoshop text layers and embedded Smart Objects (AI/PDF & nested PSD/PSB).
 *
 * Alongside the copy itself, this reports any text painted in the magenta
 * placeholder colour so the "Default Values" column can flag it.
 */
function extractTextFromLayerTree(
  layers: Layer[],
  linkedFilesMap?: Map<string, any>
): LayerTextHarvest {
  const texts: string[] = [];
  const magentaTexts: string[] = [];
  const magentaLayers: string[] = [];

  function walk(items: Layer[]) {
    for (let index = 0; index < items.length; index++) {
      const item = items[index];

      // Magenta anywhere in this layer's own properties — a shape fill, a
      // stroke, a layer effect, a gradient stop, a solid-colour fill layer.
      if (!item.hidden && magentaArtworkInLayer(item)) {
        magentaLayers.push(describeLayer(item, index));
      }

      // 1. Direct native Photoshop text layer
      if (item.text && typeof item.text.text === 'string') {
        const cleaned = item.text.text
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .trim();
        if (cleaned.length > 0) {
          texts.push(cleaned);
        }

        // Hidden layers are not part of the delivered artwork.
        if (!item.hidden) {
          magentaTexts.push(...magentaTextFromPsdLayer(item));
        }
      }

      // 2. Smart Object placed layer (vector AI/PDF or nested PSD/PSB)
      if (item.placedLayer?.id && linkedFilesMap) {
        const linked = linkedFilesMap.get(item.placedLayer.id);
        if (linked?.data && linked.data.length > 0) {
          try {
            const magic = new TextDecoder('latin1').decode(linked.data.subarray(0, 8));
            if (magic.startsWith('%PDF')) {
              // Vector AI / PDF smart object
              const extracted = extractTextFromPdfBuffer(linked.data);
              for (const pt of extracted.texts) {
                texts.push(pt);
              }
              if (!item.hidden) {
                magentaTexts.push(...extracted.magentaTexts);
              }
            } else if (magic.startsWith('8BPS') || magic.startsWith('8BPB')) {
              // Nested Photoshop / PSB smart object
              const nestedPsd = readPsd(linked.data, {
                skipLayerImageData: true,
                skipThumbnail: true,
                skipCompositeImageData: true,
                skipLinkedFilesData: false,
              });
              const nestedLinkedMap = new Map<string, any>();
              for (const nf of nestedPsd.linkedFiles || []) {
                if (nf.id) nestedLinkedMap.set(nf.id, nf);
              }
              const nested = extractTextFromLayerTree(
                nestedPsd.children || [],
                nestedLinkedMap
              );
              for (const nt of nested.texts) {
                texts.push(nt);
              }
              if (!item.hidden) {
                magentaTexts.push(...nested.magentaTexts);
                magentaLayers.push(...nested.magentaLayers);
              }
            }
          } catch (err) {
            console.warn('Could not extract text from placed smart object:', item.name, err);
          }
        }
      }

      // 3. Child layers / groups
      if (item.children && item.children.length > 0) {
        walk(item.children);
      }
    }
  }

  walk(layers);

  return {
    texts,
    magentaTexts: Array.from(new Set(magentaTexts)),
    magentaLayers: Array.from(new Set(magentaLayers)),
  };
}

/**
 * Render an artboard onto a canvas for the UI preview.
 *
 * The canvas (rather than a Blob) is returned so the caller can also run the
 * QR sweep and the magenta pixel fallback against the same pixels.
 */
function renderArtboardToCanvas(
  psd: Psd,
  artboard: ArtboardInfo,
  extractedTexts: string[]
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const w = Math.max(1, Math.round(artboard.width));
  const h = Math.max(1, Math.round(artboard.height));
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return canvas;
  }

  // White base
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);

  let drawn = false;

  // 1. Try cropping from psd.canvas (composite)
  if (psd.canvas && artboard.rect) {
    const { top, left, right, bottom } = artboard.rect;
    const cropW = right - left;
    const cropH = bottom - top;

    try {
      if (
        left >= 0 &&
        top >= 0 &&
        left + cropW <= psd.canvas.width &&
        top + cropH <= psd.canvas.height
      ) {
        ctx.drawImage(psd.canvas, left, top, cropW, cropH, 0, 0, w, h);
        drawn = true;
      } else if (psd.canvas.width === w && psd.canvas.height === h) {
        ctx.drawImage(psd.canvas, 0, 0);
        drawn = true;
      }
    } catch (e) {
      console.warn('Could not crop from psd.canvas:', e);
    }
  }

  // 2. Fallback: Draw visible child layers if they have canvases
  if (!drawn && artboard.children && artboard.children.length > 0) {
    const originX = artboard.rect ? artboard.rect.left : 0;
    const originY = artboard.rect ? artboard.rect.top : 0;

    function drawLayers(layers: Layer[]) {
      for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (layer.hidden) continue;

        if (layer.children && layer.children.length > 0) {
          drawLayers(layer.children);
        }

        if (layer.canvas) {
          const lx = (layer.left ?? 0) - originX;
          const ly = (layer.top ?? 0) - originY;
          ctx!.save();
          if (layer.opacity !== undefined) {
            ctx!.globalAlpha *= layer.opacity;
          }
          ctx!.drawImage(layer.canvas, lx, ly);
          ctx!.restore();
          drawn = true;
        }
      }
    }

    drawLayers(artboard.children);
  }

  // 3. Fallback: If no pixel data rendered, draw an informative preview card
  if (!drawn) {
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, w, h);

    // BMW Blue Accent line
    ctx.fillStyle = '#1c69d4';
    ctx.fillRect(0, 0, w, Math.max(3, Math.round(h * 0.04)));

    // Artboard title
    ctx.fillStyle = '#ffffff';
    const titleSize = Math.max(12, Math.min(22, Math.round(h * 0.1)));
    ctx.font = `600 ${titleSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.fillText(artboard.name, 16, Math.min(h * 0.25, 40));

    // Dimensions
    ctx.fillStyle = '#9ca3af';
    const dimSize = Math.max(10, Math.min(14, Math.round(titleSize * 0.75)));
    ctx.font = `${dimSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.fillText(`${w} × ${h} px`, 16, Math.min(h * 0.25, 40) + dimSize + 8);

    // Text preview
    if (extractedTexts.length > 0) {
      ctx.fillStyle = '#e5e7eb';
      const bodySize = Math.max(9, Math.min(13, Math.round(titleSize * 0.65)));
      ctx.font = `${bodySize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;

      let yOffset = Math.min(h * 0.25, 40) + dimSize + 26;
      const snippet = extractedTexts.join(' • ');
      const maxChars = Math.max(15, Math.floor(w / (bodySize * 0.58)));
      const lines = [
        snippet.slice(0, maxChars),
        snippet.slice(maxChars, maxChars * 2),
      ].filter(Boolean);

      for (const line of lines) {
        if (yOffset + bodySize < h - 8) {
          ctx.fillText(line, 16, yOffset);
          yOffset += bodySize + 4;
        }
      }
    }
  }

  return canvas;
}

/** Convert a canvas to a PNG Blob, tolerating environments without toBlob. */
function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(new Blob([], { type: 'image/png' }));
      return;
    }
    canvas.toBlob((blob) => {
      resolve(blob || new Blob([], { type: 'image/png' }));
    }, 'image/png');
  });
}

/**
 * Process a layered PSD file with all artboards and text layers.
 * Extracts artboards, inspects text layers with 100% accuracy, renders previews,
 * and performs the exact same spell check and QA evaluation.
 */
export async function processPsdFile(
  psdFile: File,
  onProgress?: (stage: string) => void
): Promise<ImageAnalysis[]> {
  onProgress?.('Reading PSD file buffer...');
  const arrayBuffer = await psdFile.arrayBuffer();

  onProgress?.('Parsing PSD layers & artboards...');
  let psd: Psd;
  try {
    psd = readPsd(arrayBuffer, {
      skipLayerImageData: true,
      skipThumbnail: true,
      skipLinkedFilesData: false,
      totalMemoryLimit: 4 * 1024 * 1024 * 1024,
    });
  } catch (readErr) {
    console.warn('PSD read with composite failed, falling back to structure-only mode:', readErr);
    psd = readPsd(arrayBuffer, {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
      skipLinkedFilesData: false,
    });
  }

  // Index linked files for smart object text extraction
  const linkedFilesMap = new Map<string, any>();
  if (psd.linkedFiles && psd.linkedFiles.length > 0) {
    for (const f of psd.linkedFiles) {
      if (f.id) {
        linkedFilesMap.set(f.id, f);
      }
    }
  }

  // 1. Discover all artboards
  const artboards: ArtboardInfo[] = [];

  if (psd.children && psd.children.length > 0) {
    for (const child of psd.children) {
      if (child.artboard && child.artboard.rect) {
        const r = child.artboard.rect;
        const w = Math.round(Math.abs(r.right - r.left));
        const h = Math.round(Math.abs(r.bottom - r.top));
        if (w > 0 && h > 0) {
          artboards.push({
            name: child.name || `Artboard ${artboards.length + 1}`,
            width: w,
            height: h,
            rect: r,
            children: child.children || [],
          });
        }
      }
    }
  }

  // Nested artboards check (if any)
  if (artboards.length === 0 && psd.children) {
    function findNestedArtboards(layers: Layer[]) {
      for (const l of layers) {
        if (l.artboard && l.artboard.rect) {
          const r = l.artboard.rect;
          const w = Math.round(Math.abs(r.right - r.left));
          const h = Math.round(Math.abs(r.bottom - r.top));
          if (w > 0 && h > 0) {
            artboards.push({
              name: l.name || `Artboard ${artboards.length + 1}`,
              width: w,
              height: h,
              rect: r,
              children: l.children || [],
            });
          }
        } else if (l.children) {
          findNestedArtboards(l.children);
        }
      }
    }
    findNestedArtboards(psd.children);
  }

  // If no artboard layer groups found, treat entire PSD as a single artboard
  if (artboards.length === 0) {
    artboards.push({
      name: psdFile.name.replace(/\.[^/.]+$/, ''),
      width: psd.width,
      height: psd.height,
      rect: { top: 0, left: 0, bottom: psd.height, right: psd.width },
      children: psd.children || [],
    });
  }

  const analyses: ImageAnalysis[] = [];

  for (let i = 0; i < artboards.length; i++) {
    const artboard = artboards[i];
    onProgress?.(`Processing artboard ${i + 1} of ${artboards.length}: ${artboard.name}...`);

    // 2. Extract text from text layers & embedded smart objects
    const harvest = extractTextFromLayerTree(artboard.children, linkedFilesMap);
    const extractedTexts = harvest.texts;
    const fullText = extractedTexts.join('\n\n');

    // 3. Render preview
    onProgress?.(`Rendering preview for ${artboard.name}...`);
    const canvas = renderArtboardToCanvas(psd, artboard, extractedTexts);
    const blob = await canvasToPngBlob(canvas);
    const previewUrl = URL.createObjectURL(blob);

    // 4. OCR / Text result
    let ocrResult: OCRResult;
    if (fullText.trim().length > 0) {
      ocrResult = {
        text: fullText.trim(),
        confidence: 100, // 100% confidence from direct PSD layer vector/text data
        words: fullText
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => ({
            text: w,
            confidence: 100,
            bbox: { x0: 0, y0: 0, x1: 0, y1: 0 },
          })),
      };
    } else {
      // Fallback to native OCR if no text layers are present
      onProgress?.(`Running OCR fallback on ${artboard.name}...`);
      try {
        ocrResult = await runOCR(previewUrl);
      } catch (err) {
        console.warn('OCR fallback failed for artboard', artboard.name, err);
        ocrResult = { text: '', confidence: 0, words: [] };
      }
    }

    // 5. Check spelling using the exact same dictionary and stemming
    onProgress?.(`Checking spelling for ${artboard.name}...`);
    const spellingIssues = checkSpelling(ocrResult.text);

    // 6. Default values — magenta placeholder copy from the layer data, with a
    //    rendered-pixel fallback for artboards that are entirely rasterised.
    let defaultValues: DefaultValueCheck = EMPTY_DEFAULT_VALUES;
    if (harvest.magentaTexts.length > 0 || harvest.magentaLayers.length > 0) {
      defaultValues = {
        hasMagenta: true,
        inText: harvest.magentaTexts.length > 0,
        samples: (harvest.magentaTexts.length > 0
          ? harvest.magentaTexts
          : harvest.magentaLayers
        ).slice(0, 8),
        method: 'layer',
      };
    } else if (scanCanvasForMagenta(canvas).found) {
      defaultValues = { hasMagenta: true, inText: false, samples: [], method: 'pixel' };
    }

    // 7. QR codes on the rendered artboard
    onProgress?.(`Scanning ${artboard.name} for QR codes...`);
    let qr: QrScanOutcome = { scanned: false, links: [] };
    try {
      qr = await analyzeQrCodes(canvas);
    } catch (err) {
      console.warn('QR scan failed for artboard', artboard.name, err);
    }

    // 8. Determine status
    let status: ImageAnalysis['status'] = 'pass';
    if (!ocrResult.text || ocrResult.text.trim().length === 0) {
      status = 'no-text';
    } else if (spellingIssues.length > 0) {
      status = 'flagged';
    }

    const displayName =
      artboards.length > 1
        ? `${psdFile.name} — ${artboard.name}`
        : `${psdFile.name}`;

    const approxSize = blob.size || Math.round(psdFile.size / artboards.length);

    const metadata: ImageMetadata = {
      fileName: displayName,
      width: artboard.width,
      height: artboard.height,
      aspectRatio: calculateAspectRatio(artboard.width, artboard.height),
      format: 'PSD Artboard',
      fileSize: approxSize,
      fileSizeFormatted: formatFileSize(approxSize),
      lastModified: psdFile.lastModified
        ? new Date(psdFile.lastModified).toLocaleString()
        : 'Unknown',
      colorDepth: '24-bit (RGB)',
    };

    analyses.push({
      id: `psd-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 6)}`,
      fileName: displayName,
      previewUrl,
      sourceType: 'psd',
      metadata,
      ocrResult,
      spellingIssues,
      status,
      qr,
      defaultValues,
    });

    // Release the render surface — a 75-artboard batch would otherwise pin
    // hundreds of megabytes of canvas backing store.
    canvas.width = 0;
    canvas.height = 0;
  }

  return analyses;
}

// ============================================
// Illustrator (.ai) Processing
// ============================================

/**
 * Process an Adobe Illustrator document: one QA row per artboard.
 *
 * Illustrator masters carry live vector copy, so spell-check runs against the
 * real text (no OCR), the QR code is decoded from a high-resolution render, and
 * magenta placeholder copy is read straight out of the fill operators.
 */
export async function processAiFile(
  aiFile: File,
  onProgress?: (stage: string) => void
): Promise<ImageAnalysis[]> {
  let artboards: Awaited<ReturnType<typeof processAiDocument>>;

  try {
    artboards = await processAiDocument(aiFile, onProgress);
  } catch (err) {
    if (err instanceof AiParseError) {
      // Not PDF-compatible — fall back to the embedded XMP thumbnail so the
      // asset still appears in the report instead of vanishing silently.
      onProgress?.('Falling back to embedded Illustrator thumbnail...');
      return [await analyzeAiFallback(aiFile, err.message)];
    }
    throw err;
  }

  const analyses: ImageAnalysis[] = [];

  for (let i = 0; i < artboards.length; i++) {
    const artboard = artboards[i];
    onProgress?.(`Analysing artboard ${i + 1} of ${artboards.length}: ${artboard.name}...`);

    const previewUrl = URL.createObjectURL(artboard.blob);
    const fullText = artboard.texts.join('\n');

    // 1. Text — vector copy is exact, so confidence is 100%.
    let ocrResult: OCRResult;
    if (fullText.trim().length > 0) {
      ocrResult = {
        text: fullText.trim(),
        confidence: 100,
        words: fullText
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => ({
            text: w,
            confidence: 100,
            bbox: { x0: 0, y0: 0, x1: 0, y1: 0 },
          })),
      };
    } else {
      // Outlined type has no text objects left — fall back to native OCR.
      onProgress?.(`Running OCR fallback on ${artboard.name}...`);
      try {
        ocrResult = await runOCR(previewUrl);
      } catch (err) {
        console.warn('OCR fallback failed for AI artboard', artboard.name, err);
        ocrResult = { text: '', confidence: 0, words: [] };
      }
    }

    // 2. Spelling — identical dictionary and stemming as every other asset.
    onProgress?.(`Checking spelling for ${artboard.name}...`);
    const spellingIssues = checkSpelling(ocrResult.text);

    // 3. QR codes — thorough sweep, the QR is usually a small corner block.
    onProgress?.(`Scanning ${artboard.name} for QR codes...`);
    let qr: QrScanOutcome = { scanned: false, links: [] };
    try {
      qr = await analyzeQrCodes(artboard.canvas, { thorough: true });
    } catch (err) {
      console.warn('QR scan failed for AI artboard', artboard.name, err);
    }
    if (!qr.scanned) {
      // No render to inspect, but the column still applies to AI assets.
      qr = { scanned: true, links: [] };
    }

    // 4. Default values — magenta fills on the vector text.
    let defaultValues: DefaultValueCheck = EMPTY_DEFAULT_VALUES;
    if (artboard.hasMagenta) {
      // Samples can legitimately be empty — outlined type has no glyphs, and an
      // unreadable subset font decodes to nothing. Neither makes the magenta
      // any less present.
      defaultValues = {
        hasMagenta: true,
        inText: artboard.magentaInText,
        samples: artboard.magentaTexts.slice(0, 8),
        method: 'vector',
      };
    } else if (artboard.canvas && scanCanvasForMagenta(artboard.canvas).found) {
      defaultValues = { hasMagenta: true, inText: false, samples: [], method: 'pixel' };
    }

    let status: ImageAnalysis['status'] = 'pass';
    if (!ocrResult.text || ocrResult.text.trim().length === 0) {
      status = 'no-text';
    } else if (spellingIssues.length > 0) {
      status = 'flagged';
    }

    const displayName =
      artboards.length > 1 ? `${aiFile.name} — ${artboard.name}` : aiFile.name;

    const approxSize = artboard.blob.size || Math.round(aiFile.size / artboards.length);

    analyses.push({
      id: `ai-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 6)}`,
      fileName: displayName,
      previewUrl,
      sourceType: 'ai',
      metadata: {
        fileName: displayName,
        width: artboard.width,
        height: artboard.height,
        aspectRatio: calculateAspectRatio(artboard.width, artboard.height),
        format: 'AI Artboard',
        fileSize: approxSize,
        fileSizeFormatted: formatFileSize(approxSize),
        lastModified: aiFile.lastModified
          ? new Date(aiFile.lastModified).toLocaleString()
          : 'Unknown',
        colorDepth: '24-bit (RGB)',
      },
      ocrResult,
      spellingIssues,
      status,
      qr,
      defaultValues,
    });

    if (artboard.canvas) {
      artboard.canvas.width = 0;
      artboard.canvas.height = 0;
      artboard.canvas = null;
    }
  }

  return analyses;
}

/**
 * Fallback row for an .ai file saved without PDF compatibility: preview from
 * the XMP thumbnail, QR scanned from that thumbnail, no vector text available.
 */
async function analyzeAiFallback(aiFile: File, reason: string): Promise<ImageAnalysis> {
  const thumbnail = await extractAiXmpThumbnail(aiFile);

  let img: HTMLImageElement | null = null;
  if (thumbnail) {
    try {
      img = await loadImage(thumbnail);
    } catch {
      img = null;
    }
  }

  let qr: QrScanOutcome = { scanned: true, links: [] };
  if (img) {
    try {
      qr = await analyzeQrCodes(img, { thorough: true });
    } catch (err) {
      console.warn('QR scan failed for AI fallback preview:', err);
    }
  }

  const width = img?.naturalWidth ?? 0;
  const height = img?.naturalHeight ?? 0;

  console.warn(`Illustrator file read in fallback mode: ${reason}`);

  return {
    id: `ai-${Date.now()}-fallback-${Math.random().toString(36).substr(2, 6)}`,
    fileName: aiFile.name,
    previewUrl: thumbnail || '',
    sourceType: 'ai',
    metadata: {
      fileName: aiFile.name,
      width,
      height,
      aspectRatio: width && height ? calculateAspectRatio(width, height) : '—',
      format: 'AI (No PDF Data)',
      fileSize: aiFile.size,
      fileSizeFormatted: formatFileSize(aiFile.size),
      lastModified: aiFile.lastModified
        ? new Date(aiFile.lastModified).toLocaleString()
        : 'Unknown',
      colorDepth: '24-bit (RGB)',
    },
    ocrResult: { text: '', confidence: 0, words: [] },
    spellingIssues: [],
    status: 'no-text',
    qr,
    defaultValues: img ? detectMagentaInImage(img) : EMPTY_DEFAULT_VALUES,
  };
}
