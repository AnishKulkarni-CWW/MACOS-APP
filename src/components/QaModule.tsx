import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import type { ImageAnalysis, ProcessingProgress, QrLinkResult } from './qaUtils';
import {
  analyzeImage,
  initOCRWorker,
  isAiFile,
  isPsdFile,
  isSupportedAsset,
  isZipFile,
  processAiFile,
  processZipFile,
  processPsdFile,
  resetLinkCache,
  terminateOCRWorker,
} from './qaUtils';
import {
  applyFilters,
  availableDimensions,
  availableFormats,
  DEFAULT_FILTERS,
  isFiltered as hasActiveFilters,
  type QaFilters,
} from './qaFilters';
import './QaModule.css';

type QaView = 'upload' | 'processing' | 'report';

export function QaModule() {
  const [view, setView] = useState<QaView>('upload');
  const [analyses, setAnalyses] = useState<ImageAnalysis[]>([]);
  const [progress, setProgress] = useState<ProcessingProgress>({
    stage: 'reading',
    stageLabel: 'Reading files...',
    current: 0,
    total: 0,
    percent: 0,
  });
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Cleanup OCR worker on unmount
  useEffect(() => {
    return () => {
      terminateOCRWorker();
    };
  }, []);

  // ============================================
  // File Handling
  // ============================================

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    setView('processing');
    setAnalyses([]);
    // Link verdicts are cached per batch so a shared landing page is only
    // fetched once; a new analysis must re-validate.
    resetLinkCache();

    try {
      const filesToProcess: File[] = [];

      for (const file of fileArray) {
        if (isZipFile(file.name)) {
          setProgress({
            stage: 'reading',
            stageLabel: `Extracting ${file.name}...`,
            current: 0,
            total: 0,
            percent: 5,
          });

          const extracted = await processZipFile(file);
          filesToProcess.push(...extracted.map((e) => e.file));
        } else if (isSupportedAsset(file.name)) {
          filesToProcess.push(file);
        }
      }

      if (filesToProcess.length === 0) {
        alert(
          'No supported assets found. Upload an image (JPG, PNG), a PSD, an Illustrator (AI) file, or a ZIP archive containing them.'
        );
        setView('upload');
        return;
      }

      // Initialize OCR worker (for non-PSD or raster layers fallback)
      setProgress({
        stage: 'reading',
        stageLabel: 'Initializing QC engines...',
        current: 0,
        total: filesToProcess.length,
        percent: 10,
      });

      await initOCRWorker();

      // Process each file (PSD and AI files may contain multiple artboards)
      const results: ImageAnalysis[] = [];

      for (let i = 0; i < filesToProcess.length; i++) {
        const currentFile = filesToProcess[i];
        const basePercent = 15 + (i / filesToProcess.length) * 80;

        const reportStage = (stage: string) => {
          setProgress((prev) => ({
            ...prev,
            stageLabel: `${currentFile.name}: ${stage}`,
          }));
        };

        if (isPsdFile(currentFile.name)) {
          setProgress({
            stage: 'reading',
            stageLabel: `Processing PSD: ${currentFile.name}...`,
            current: i + 1,
            total: filesToProcess.length,
            percent: Math.round(basePercent),
          });

          results.push(...(await processPsdFile(currentFile, reportStage)));
        } else if (isAiFile(currentFile.name)) {
          setProgress({
            stage: 'reading',
            stageLabel: `Processing Illustrator file: ${currentFile.name}...`,
            current: i + 1,
            total: filesToProcess.length,
            percent: Math.round(basePercent),
          });

          try {
            results.push(...(await processAiFile(currentFile, reportStage)));
          } catch (aiErr) {
            console.error('Illustrator analysis failed for', currentFile.name, aiErr);
            alert(
              `Could not analyse "${currentFile.name}".\n\nIllustrator files must be saved with "Create PDF Compatible File" enabled for QA to read their artboards.`
            );
          }
        } else {
          setProgress({
            stage: 'ocr',
            stageLabel: `Analyzing ${currentFile.name}...`,
            current: i + 1,
            total: filesToProcess.length,
            percent: Math.round(basePercent),
          });

          results.push(await analyzeImage(currentFile, reportStage));
        }

        setAnalyses([...results]);
      }

      if (results.length === 0) {
        setView('upload');
        return;
      }

      setProgress({
        stage: 'complete',
        stageLabel: 'Analysis complete',
        current: filesToProcess.length,
        total: filesToProcess.length,
        percent: 100,
      });

      // Small delay for the progress bar to reach 100%
      await new Promise((r) => setTimeout(r, 400));

      setAnalyses(results);
      setView('report');
    } catch (err) {
      console.error('QA Analysis error:', err);
      alert('An error occurred during analysis. Please try again.');
      setView('upload');
    }
  }, []);

  // Drag & Drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        processFiles(e.dataTransfer.files);
      }
    },
    [processFiles]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        processFiles(e.target.files);
      }
    },
    [processFiles]
  );

  const handleReset = useCallback(() => {
    // Revoke all preview URLs
    for (const a of analyses) {
      if (a.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(a.previewUrl);
      }
    }
    setAnalyses([]);
    setView('upload');
    setExpandedRow(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [analyses]);

  // ============================================
  // Render Views
  // ============================================

  return (
    <div>
      <div className="module-header">
        <h1>QA Evaluation</h1>
        <p>Inspect image assets for dimensions, specifications, and content accuracy.</p>
      </div>

      {view === 'upload' && (
        <UploadView
          isDragOver={isDragOver}
          fileInputRef={fileInputRef}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onFileSelect={handleFileSelect}
          onBrowseClick={() => fileInputRef.current?.click()}
        />
      )}

      {view === 'processing' && <ProcessingView progress={progress} />}

      {view === 'report' && (
        <ReportView
          analyses={analyses}
          expandedRow={expandedRow}
          onExpandRow={setExpandedRow}
          onReset={handleReset}
        />
      )}
    </div>
  );
}

// ============================================
// Upload View
// ============================================

interface UploadViewProps {
  isDragOver: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onBrowseClick: () => void;
}

function UploadView({
  isDragOver,
  fileInputRef,
  onDragOver,
  onDragLeave,
  onDrop,
  onFileSelect,
  onBrowseClick,
}: UploadViewProps) {
  return (
    <div className="qa-upload-screen">
      <div
        className={`qa-dropzone ${isDragOver ? 'drag-over' : ''}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onBrowseClick}
      >
        <div className="qa-dropzone-icon">📁</div>
        <div className="qa-dropzone-text">
          <h3>Drop image files, PSD or Illustrator artboards, or a ZIP archive</h3>
          <p>Click to browse or drag and drop</p>
        </div>
        <div className="qa-dropzone-formats">
          <span className="qa-format-badge">JPG</span>
          <span className="qa-format-badge">PNG</span>
          <span className="qa-format-badge">PSD</span>
          <span className="qa-format-badge">AI</span>
          <span className="qa-format-badge">ZIP</span>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".jpg,.jpeg,.png,.gif,.webp,.bmp,.tiff,.tif,.psd,.ai,.zip"
          multiple
          style={{ display: 'none' }}
          onChange={onFileSelect}
        />
      </div>
    </div>
  );
}

// ============================================
// Processing View
// ============================================

function ProcessingView({ progress }: { progress: ProcessingProgress }) {
  return (
    <div className="qa-processing">
      <div className="qa-processing-spinner" />
      <div className="qa-processing-info">
        <h3>Analyzing Assets</h3>
        <div className="qa-processing-stage">
          <span>{progress.stageLabel}</span>
        </div>
        {progress.total > 1 && (
          <div className="qa-progress-label">
            Image {progress.current} of {progress.total}
          </div>
        )}
      </div>
      <div className="qa-progress-bar">
        <div
          className="qa-progress-fill"
          style={{ width: `${progress.percent}%` }}
        />
      </div>
      <div className="qa-progress-label">{progress.percent}%</div>
    </div>
  );
}

// ============================================
// Report View (auto-selects single vs multi)
// ============================================

interface ReportViewProps {
  analyses: ImageAnalysis[];
  expandedRow: string | null;
  onExpandRow: (id: string | null) => void;
  onReset: () => void;
}

function ReportView({ analyses, expandedRow, onExpandRow, onReset }: ReportViewProps) {
  const isSingle = analyses.length === 1;

  return (
    <div className="qa-report">
      <div className="qa-report-header">
        <button className="btn-secondary" onClick={onReset}>
          ← New Analysis
        </button>
        <h2>{isSingle ? 'Image QC Report' : `Batch QC Report — ${analyses.length} Images`}</h2>
        <OverallStatus analyses={analyses} />
      </div>

      {isSingle ? (
        <SingleImageReport analysis={analyses[0]} />
      ) : (
        <MultiImageReport
          analyses={analyses}
          expandedRow={expandedRow}
          onExpandRow={onExpandRow}
        />
      )}
    </div>
  );
}

// ============================================
// Overall Status Badge
// ============================================

function OverallStatus({ analyses }: { analyses: ImageAnalysis[] }) {
  const flagged = analyses.filter((a) => a.status === 'flagged').length;
  const passed = analyses.filter((a) => a.status === 'pass').length;
  const noText = analyses.filter((a) => a.status === 'no-text').length;

  if (flagged > 0) {
    return (
      <span className="qa-status-badge flagged">
        🚩 {flagged} Flagged
      </span>
    );
  }
  if (noText === analyses.length) {
    return (
      <span className="qa-status-badge no-text">
        — No text detected
      </span>
    );
  }
  return (
    <span className="qa-status-badge pass">
      ✅ {passed} Passed
    </span>
  );
}

// ============================================
// Single Image Report
// ============================================

function SingleImageReport({ analysis }: { analysis: ImageAnalysis }) {
  const { metadata, ocrResult, spellingIssues, status, previewUrl } = analysis;

  return (
    <div className="qa-single-report">
      {/* Left: Image Preview */}
      <div className="qa-single-preview">
        <div className="qa-preview-image-container">
          <img src={previewUrl} alt={metadata.fileName} />
        </div>
      </div>

      {/* Right: Details */}
      <div className="qa-single-details">
        {/* Dimensions & Specs Card */}
        <div className="qa-spec-card qa-fade-in">
          <h4>Dimensions & Specifications</h4>
          <div className="qa-spec-grid">
            <div className="qa-spec-item">
              <span className="qa-spec-label">Width</span>
              <span className="qa-spec-value large">{metadata.width}px</span>
            </div>
            <div className="qa-spec-item">
              <span className="qa-spec-label">Height</span>
              <span className="qa-spec-value large">{metadata.height}px</span>
            </div>
            <div className="qa-spec-item">
              <span className="qa-spec-label">Aspect Ratio</span>
              <span className="qa-spec-value">{metadata.aspectRatio}</span>
            </div>
            <div className="qa-spec-item">
              <span className="qa-spec-label">Color Depth</span>
              <span className="qa-spec-value">{metadata.colorDepth}</span>
            </div>
          </div>
        </div>

        {/* File Format & Size Card */}
        <div className="qa-spec-card qa-fade-in qa-stagger-1">
          <h4>File Information</h4>
          <div className="qa-spec-grid">
            <div className="qa-spec-item">
              <span className="qa-spec-label">Format</span>
              <span className="qa-spec-value">{metadata.format}</span>
            </div>
            <div className="qa-spec-item">
              <span className="qa-spec-label">File Size</span>
              <span className="qa-spec-value">{metadata.fileSizeFormatted}</span>
            </div>
            <div className="qa-spec-item full-width">
              <span className="qa-spec-label">File Name</span>
              <span className="qa-spec-value">{metadata.fileName}</span>
            </div>
            <div className="qa-spec-item full-width">
              <span className="qa-spec-label">Last Modified</span>
              <span className="qa-spec-value">{metadata.lastModified}</span>
            </div>
          </div>
        </div>

        {/* QR Links & Default Values */}
        <div className="qa-spec-card qa-fade-in qa-stagger-2">
          <h4>QR Links & Default Values</h4>
          <div className="qa-spec-grid">
            <div className="qa-spec-item full-width">
              <span className="qa-spec-label">QR Links</span>
              <QrLinksCell analysis={analysis} />
            </div>
            <div className="qa-spec-item full-width">
              <span className="qa-spec-label">Default Values</span>
              <DefaultValuesCell analysis={analysis} />
            </div>
          </div>
          <QrLinkDetails links={analysis.qr.links} />
          <DefaultValueSamples analysis={analysis} />
        </div>

        {/* Content & Spelling Analysis */}
        <div className="qa-content-card qa-fade-in qa-stagger-3">
          <h4>
            Content & Spelling Analysis
            <StatusBadge status={status} count={spellingIssues.length} />
          </h4>

          {/* OCR / Text Confidence */}
          {ocrResult.text && (
            <div className="qa-ocr-confidence">
              <span className="qa-spec-label" style={{ minWidth: 70 }}>
                {metadata.format.includes('PSD') || metadata.format.includes('AI')
                  ? 'Text Confidence'
                  : 'OCR Confidence'}
              </span>
              <div className="qa-confidence-bar">
                <div
                  className={`qa-confidence-fill ${
                    ocrResult.confidence >= 80
                      ? 'high'
                      : ocrResult.confidence >= 50
                      ? 'medium'
                      : 'low'
                  }`}
                  style={{ width: `${ocrResult.confidence}%` }}
                />
              </div>
              <span className="qa-confidence-label">
                {Math.round(ocrResult.confidence)}%
              </span>
            </div>
          )}

          {/* Extracted Text */}
          <div className={`qa-extracted-text ${!ocrResult.text ? 'empty' : ''}`}>
            {ocrResult.text || 'No text detected in this image.'}
          </div>

          {/* Spelling Issues */}
          <SpellingIssuesList issues={spellingIssues} />
        </div>
      </div>
    </div>
  );
}

// ============================================
// Filters
// ============================================

interface FilterBarProps {
  analyses: ImageAnalysis[];
  filters: QaFilters;
  onChange: (filters: QaFilters) => void;
  showQrFilter: boolean;
  visibleCount: number;
}

function FilterBar({ analyses, filters, onChange, showQrFilter, visibleCount }: FilterBarProps) {
  const formats = useMemo(() => availableFormats(analyses), [analyses]);
  const dimensions = useMemo(() => availableDimensions(analyses), [analyses]);

  const isFiltered = hasActiveFilters(filters);

  const set = <K extends keyof QaFilters>(key: K, value: QaFilters[K]) =>
    onChange({ ...filters, [key]: value });

  return (
    <div className="qa-filter-bar qa-fade-in qa-stagger-3">
      <div className="qa-filter-field grow">
        <label htmlFor="qa-filter-search">File Name</label>
        <input
          id="qa-filter-search"
          type="search"
          placeholder="Search file names..."
          value={filters.search}
          onChange={(e) => set('search', e.target.value)}
        />
      </div>

      <div className="qa-filter-field">
        <label htmlFor="qa-filter-dimensions">Dimensions</label>
        <select
          id="qa-filter-dimensions"
          value={filters.dimensions}
          onChange={(e) => set('dimensions', e.target.value)}
        >
          <option value="all">All sizes</option>
          {dimensions.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>

      <div className="qa-filter-field">
        <label htmlFor="qa-filter-format">Format</label>
        <select
          id="qa-filter-format"
          value={filters.format}
          onChange={(e) => set('format', e.target.value)}
        >
          <option value="all">All formats</option>
          {formats.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>

      {showQrFilter && (
        <div className="qa-filter-field">
          <label htmlFor="qa-filter-qr">QR Links</label>
          <select
            id="qa-filter-qr"
            value={filters.qr}
            onChange={(e) => set('qr', e.target.value as QaFilters['qr'])}
          >
            <option value="all">All links</option>
            <option value="working">Working link</option>
            <option value="broken">Broken link</option>
            <option value="indian">IN link</option>
            <option value="non-indian">Non-IN link</option>
            <option value="none">No QR found</option>
          </select>
        </div>
      )}

      <div className="qa-filter-field">
        <label htmlFor="qa-filter-defaults">Default Values</label>
        <select
          id="qa-filter-defaults"
          value={filters.defaults}
          onChange={(e) => set('defaults', e.target.value as QaFilters['defaults'])}
        >
          <option value="all">All</option>
          <option value="default">Default text</option>
          <option value="clean">No default text</option>
        </select>
      </div>

      <div className="qa-filter-field">
        <label htmlFor="qa-filter-status">Status</label>
        <select
          id="qa-filter-status"
          value={filters.status}
          onChange={(e) => set('status', e.target.value as QaFilters['status'])}
        >
          <option value="all">All statuses</option>
          <option value="pass">Passed</option>
          <option value="flagged">Flagged</option>
          <option value="no-text">No text</option>
        </select>
      </div>

      <div className="qa-filter-actions">
        <span className="qa-filter-count">
          {visibleCount} of {analyses.length}
        </span>
        <button
          type="button"
          className="qa-filter-clear"
          onClick={() => onChange(DEFAULT_FILTERS)}
          disabled={!isFiltered}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

// ============================================
// Multi-Image Report
// ============================================

interface MultiImageReportProps {
  analyses: ImageAnalysis[];
  expandedRow: string | null;
  onExpandRow: (id: string | null) => void;
}

function MultiImageReport({ analyses, expandedRow, onExpandRow }: MultiImageReportProps) {
  const [filters, setFilters] = useState<QaFilters>(DEFAULT_FILTERS);

  // The QR Links column belongs to Illustrator deliveries; it also appears if a
  // QR turned up on any other asset in the batch.
  const showQrColumn = useMemo(
    () => analyses.some((a) => a.sourceType === 'ai' || a.qr.links.length > 0),
    [analyses]
  );

  const visible = useMemo(() => applyFilters(analyses, filters), [analyses, filters]);

  const totalSize = visible.reduce((sum, a) => sum + a.metadata.fileSize, 0);
  const passCount = visible.filter((a) => a.status === 'pass').length;
  const flaggedCount = visible.filter((a) => a.status === 'flagged').length;
  const noTextCount = visible.filter((a) => a.status === 'no-text').length;

  const formatSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const isFiltered = visible.length !== analyses.length;

  return (
    <>
      {/* Summary Stats */}
      <div className="qa-multi-summary">
        <div className="qa-summary-stat qa-fade-in">
          <span className="stat-value">{visible.length}</span>
          <span className="stat-label">{isFiltered ? 'Filtered Images' : 'Total Images'}</span>
        </div>
        <div className="qa-summary-stat qa-fade-in qa-stagger-1">
          <span className="stat-value">{formatSize(totalSize)}</span>
          <span className="stat-label">Total Size</span>
        </div>
        <div className="qa-summary-stat pass-stat qa-fade-in qa-stagger-2">
          <span className="stat-value">{passCount + noTextCount}</span>
          <span className="stat-label">Passed</span>
        </div>
        <div className="qa-summary-stat flagged-stat qa-fade-in qa-stagger-3">
          <span className="stat-value">{flaggedCount}</span>
          <span className="stat-label">Flagged</span>
        </div>
      </div>

      <FilterBar
        analyses={analyses}
        filters={filters}
        onChange={setFilters}
        showQrFilter={showQrColumn}
        visibleCount={visible.length}
      />

      {/* Image Table */}
      <div className={`qa-image-table qa-fade-in qa-stagger-4 ${showQrColumn ? 'has-qr' : ''}`}>
        <div className="qa-table-header">
          <span></span>
          <span>File Name</span>
          <span>Dimensions</span>
          <span>Format &amp; Size</span>
          {showQrColumn && <span>QR Links</span>}
          <span>Default Values</span>
          <span>Status</span>
        </div>

        {visible.length === 0 && (
          <div className="qa-table-empty">No assets match the current filters.</div>
        )}

        {visible.map((analysis) => (
          <div key={analysis.id}>
            <div
              className={`qa-table-row ${expandedRow === analysis.id ? 'expanded' : ''}`}
              onClick={() =>
                onExpandRow(expandedRow === analysis.id ? null : analysis.id)
              }
            >
              <div className="qa-table-thumb">
                <img src={analysis.previewUrl} alt={analysis.fileName} />
              </div>
              <div className="qa-table-filename" title={analysis.fileName}>
                {analysis.fileName}
              </div>
              <div className="qa-table-dim">
                {analysis.metadata.width}×{analysis.metadata.height}
              </div>
              <div className="qa-table-size">
                <span className="format-tag">{analysis.metadata.format}</span>
                {analysis.metadata.fileSizeFormatted}
              </div>
              {showQrColumn && (
                <div className="qa-table-qr">
                  <QrLinksCell analysis={analysis} compact />
                </div>
              )}
              <div className="qa-table-defaults">
                <DefaultValuesCell analysis={analysis} />
              </div>
              <div>
                <StatusBadge
                  status={analysis.status}
                  count={analysis.spellingIssues.length}
                  compact
                />
              </div>
            </div>

            {/* Expanded Detail */}
            {expandedRow === analysis.id && (
              <div className="qa-expanded-detail">
                <div className="qa-expanded-inner">
                  <div className="qa-expanded-preview">
                    <img src={analysis.previewUrl} alt={analysis.fileName} />
                  </div>
                  <div className="qa-expanded-analysis">
                    {/* Specs */}
                    <div className="qa-spec-grid" style={{ fontSize: '13px' }}>
                      <div className="qa-spec-item">
                        <span className="qa-spec-label">Aspect Ratio</span>
                        <span className="qa-spec-value">{analysis.metadata.aspectRatio}</span>
                      </div>
                      <div className="qa-spec-item">
                        <span className="qa-spec-label">Color Depth</span>
                        <span className="qa-spec-value">{analysis.metadata.colorDepth}</span>
                      </div>
                    </div>

                    {/* QR link detail */}
                    <QrLinkDetails links={analysis.qr.links} />

                    {/* Magenta placeholder copy */}
                    <DefaultValueSamples analysis={analysis} />

                    {/* OCR Confidence */}
                    {analysis.ocrResult.text && (
                      <div className="qa-ocr-confidence">
                        <span className="qa-spec-label" style={{ minWidth: 70 }}>
                          OCR
                        </span>
                        <div className="qa-confidence-bar">
                          <div
                            className={`qa-confidence-fill ${
                              analysis.ocrResult.confidence >= 80
                                ? 'high'
                                : analysis.ocrResult.confidence >= 50
                                ? 'medium'
                                : 'low'
                            }`}
                            style={{ width: `${analysis.ocrResult.confidence}%` }}
                          />
                        </div>
                        <span className="qa-confidence-label">
                          {Math.round(analysis.ocrResult.confidence)}%
                        </span>
                      </div>
                    )}

                    {/* Extracted Text */}
                    <div
                      className={`qa-extracted-text ${
                        !analysis.ocrResult.text ? 'empty' : ''
                      }`}
                    >
                      {analysis.ocrResult.text || 'No text detected.'}
                    </div>

                    {/* Spelling Issues */}
                    <SpellingIssuesList issues={analysis.spellingIssues} />
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// ============================================
// QR Links
// ============================================

function linkTitle(link: QrLinkResult): string {
  const parts = [link.url];
  if (link.finalUrl) parts.push(`→ ${link.finalUrl}`);
  if (typeof link.httpStatus === 'number') parts.push(`HTTP ${link.httpStatus}`);
  if (link.error) parts.push(link.error);
  return parts.join('\n');
}

/**
 * The QR Links cell reports both QA parameters as a pair: whether the link
 * resolves, and whether it points at an Indian destination.
 */
function QrLinksCell({ analysis, compact }: { analysis: ImageAnalysis; compact?: boolean }) {
  const { qr } = analysis;

  if (!qr.scanned) {
    return <span className="qa-cell-muted">—</span>;
  }

  if (qr.links.length === 0) {
    return <span className="qa-qr-badge none">No QR</span>;
  }

  return (
    <div className="qa-qr-cell">
      {qr.links.map((link, idx) => (
        <div className="qa-qr-pair" key={`${link.raw}-${idx}`} title={linkTitle(link)}>
          {link.linkStatus === 'working' && (
            <span className="qa-qr-badge working">✅ Working Link</span>
          )}
          {link.linkStatus === 'broken' && (
            <span className="qa-qr-badge broken">⛔ Broken Link</span>
          )}
          {link.linkStatus === 'unknown' && (
            <span className="qa-qr-badge unknown">? Unverified</span>
          )}
          {link.isIndian && <span className="qa-qr-badge indian">IN Link</span>}
          {!compact && !link.isIndian && link.isUrl && (
            <span className="qa-qr-badge non-indian">Non-IN</span>
          )}
        </div>
      ))}
    </div>
  );
}

function QrLinkDetails({ links }: { links: QrLinkResult[] }) {
  if (links.length === 0) return null;

  return (
    <div className="qa-qr-details">
      {links.map((link, idx) => (
        <div className="qa-qr-detail" key={`${link.raw}-${idx}`}>
          <span className="qa-qr-detail-url" title={link.raw}>
            {link.url}
          </span>
          <span className="qa-qr-detail-meta">
            {link.finalUrl ? `→ ${link.finalUrl} · ` : ''}
            {typeof link.httpStatus === 'number' ? `HTTP ${link.httpStatus}` : link.error || '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

// ============================================
// Default Values (magenta placeholder copy)
// ============================================

function DefaultValuesCell({ analysis }: { analysis: ImageAnalysis }) {
  if (!analysis.defaultValues.hasMagentaText) {
    return <span className="qa-cell-muted">—</span>;
  }
  return <span className="qa-status-badge pass">✅ Default Text</span>;
}

function DefaultValueSamples({ analysis }: { analysis: ImageAnalysis }) {
  const { hasMagentaText, samples, method } = analysis.defaultValues;
  if (!hasMagentaText) return null;

  return (
    <div className="qa-default-values">
      <div className="qa-default-values-head">
        <span className="qa-magenta-swatch" aria-hidden="true" />
        <span>
          Magenta (#FF00FF) text detected
          {method === 'pixel' ? ' in the rendered artwork' : ' in the layer data'}
        </span>
      </div>
      {samples.length > 0 && (
        <div className="qa-default-values-list">
          {samples.map((sample, idx) => (
            <span className="qa-default-value-chip" key={`${sample}-${idx}`}>
              {sample}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================
// Shared Sub-Components
// ============================================

function StatusBadge({
  status,
  count,
  compact,
}: {
  status: ImageAnalysis['status'];
  count: number;
  compact?: boolean;
}) {
  if (status === 'flagged') {
    return (
      <span className="qa-status-badge flagged">
        🚩 {compact ? count : `${count} issue${count !== 1 ? 's' : ''}`}
      </span>
    );
  }
  if (status === 'no-text') {
    return (
      <span className="qa-status-badge no-text">
        {compact ? '—' : 'No text'}
      </span>
    );
  }
  return (
    <span className="qa-status-badge pass">
      ✅ {compact ? '' : 'Pass'}
    </span>
  );
}

function SpellingIssuesList({ issues }: { issues: ImageAnalysis['spellingIssues'] }) {
  if (issues.length === 0) {
    return (
      <div className="qa-no-issues">
        <span>✅</span>
        <span>No spelling issues detected</span>
      </div>
    );
  }

  return (
    <div className="qa-spelling-issues">
      {issues.map((issue, idx) => (
        <div key={idx} className="qa-spelling-issue">
          <span className="qa-spelling-flag">🚩</span>
          <div className="qa-spelling-details">
            <span className="qa-misspelled-word">{issue.word}</span>
            <div className="qa-spelling-context">{issue.context}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
