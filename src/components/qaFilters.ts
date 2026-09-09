/**
 * qaFilters — the filter model behind the QA Evaluation results table.
 *
 * Kept out of the component so the matching rules can be reasoned about (and
 * tested) on their own.
 */

import type { ImageAnalysis } from './qaUtils';

export interface QaFilters {
  /** Case-insensitive substring match on the file name. */
  search: string;
  status: 'all' | 'pass' | 'flagged' | 'no-text';
  /** Exact match on `metadata.format`, or 'all'. */
  format: string;
  /** Exact match on the `WxH` key, or 'all'. */
  dimensions: string;
  qr: 'all' | 'working' | 'broken' | 'indian' | 'non-indian' | 'none';
  defaults: 'all' | 'default' | 'clean';
}

export const DEFAULT_FILTERS: QaFilters = {
  search: '',
  status: 'all',
  format: 'all',
  dimensions: 'all',
  qr: 'all',
  defaults: 'all',
};

/** The value shown in the Dimensions column, used as that filter's key. */
export function dimensionKey(analysis: ImageAnalysis): string {
  return `${analysis.metadata.width}×${analysis.metadata.height}`;
}

export function isFiltered(filters: QaFilters): boolean {
  return (
    filters.search !== '' ||
    filters.status !== 'all' ||
    filters.format !== 'all' ||
    filters.dimensions !== 'all' ||
    filters.qr !== 'all' ||
    filters.defaults !== 'all'
  );
}

/**
 * An artboard matches a QR filter if *any* of its links satisfies it — except
 * 'non-indian', which means "has links and none of them is Indian", and 'none',
 * which means no QR was decoded at all.
 */
export function matchesQrFilter(analysis: ImageAnalysis, filter: QaFilters['qr']): boolean {
  const links = analysis.qr.links;

  switch (filter) {
    case 'all':
      return true;
    case 'none':
      return links.length === 0;
    case 'working':
      return links.some((l) => l.linkStatus === 'working');
    case 'broken':
      return links.some((l) => l.linkStatus === 'broken');
    case 'indian':
      return links.some((l) => l.isIndian);
    case 'non-indian':
      return links.length > 0 && links.every((l) => !l.isIndian);
    default:
      return true;
  }
}

/** Apply every active filter. Filters combine with AND. */
export function applyFilters(analyses: ImageAnalysis[], filters: QaFilters): ImageAnalysis[] {
  const search = filters.search.trim().toLowerCase();

  return analyses.filter((a) => {
    if (search && !a.fileName.toLowerCase().includes(search)) return false;
    if (filters.status !== 'all' && a.status !== filters.status) return false;
    if (filters.format !== 'all' && a.metadata.format !== filters.format) return false;
    if (filters.dimensions !== 'all' && dimensionKey(a) !== filters.dimensions) return false;
    if (!matchesQrFilter(a, filters.qr)) return false;

    if (filters.defaults === 'default' && !a.defaultValues.hasMagenta) return false;
    if (filters.defaults === 'clean' && a.defaultValues.hasMagenta) return false;

    return true;
  });
}

/** Distinct format values present in a batch, alphabetically. */
export function availableFormats(analyses: ImageAnalysis[]): string[] {
  return Array.from(new Set(analyses.map((a) => a.metadata.format))).sort();
}

/**
 * Distinct dimension keys present in a batch, most common first — that is the
 * order a reviewer scans a size-driven delivery in.
 */
export function availableDimensions(analyses: ImageAnalysis[]): string[] {
  const counts = new Map<string, number>();
  for (const a of analyses) {
    const key = dimensionKey(a);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
}
