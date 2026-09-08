import { useState, useRef, useCallback, useEffect } from 'react';
import type { ImageAnalysis, ProcessingProgress } from './qaUtils';
import {
  analyzeImage,
  initOCRWorker,
  terminateOCRWorker,
  processZipFile,
  processPsdFile,
} from './qaUtils';
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

    try {
      let filesToProcess: File[] = [];
      const file = fileArray[0];

      // Check if ZIP
      if (file.name.toLowerCase().endsWith('.zip')) {
        setProgress({
          stage: 'reading',
          stageLabel: 'Extracting ZIP archive...',
          current: 0,
          total: 0,
          percent: 5,
        });

        const extracted = await processZipFile(file);
        filesToProcess = extracted.map((e) => e.file);

        if (filesToProcess.length === 0) {
          alert('No image or PSD files found in the ZIP archive.');
          setView('upload');
          return;
        }
      } else {
        // Single image, PSD, or multiple files dropped
        const supportedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.psd'];
        filesToProcess = fileArray.filter((f) => {
          const ext = '.' + f.name.split('.').pop()?.toLowerCase();
          return supportedExts.includes(ext);
        });

        if (filesToProcess.length === 0) {
          alert('Please upload an image file (JPG, PNG), a PSD file, or a ZIP archive.');
          setView('upload');
          return;
        }
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

      // Process each file (PSD files may contain multiple artboards)
      const results: ImageAnalysis[] = [];

      for (let i = 0; i < filesToProcess.length; i++) {
        const currentFile = filesToProcess[i];
        const isPsd = currentFile.name.toLowerCase().endsWith('.psd');
        const basePercent = 15 + ((i / filesToProcess.length) * 80);

        if (isPsd) {
          setProgress({
            stage: 'reading',
            stageLabel: `Processing PSD: ${currentFile.name}...`,
            current: i + 1,
            total: filesToProcess.length,
            percent: Math.round(basePercent),
          });

          const psdAnalyses = await processPsdFile(currentFile, (stage) => {
            setProgress((prev) => ({
              ...prev,
              stageLabel: `${currentFile.name}: ${stage}`,
            }));
          });

          results.push(...psdAnalyses);
          setAnalyses([...results]);
        } else {
          setProgress({
            stage: 'ocr',
            stageLabel: `Analyzing ${currentFile.name}...`,
            current: i + 1,
            total: filesToProcess.length,
            percent: Math.round(basePercent),
          });

          const analysis = await analyzeImage(currentFile, (stage) => {
            setProgress((prev) => ({
              ...prev,
              stageLabel: `${currentFile.name}: ${stage}`,
            }));
          });

          results.push(analysis);
          setAnalyses([...results]);
        }
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
      URL.revokeObjectURL(a.previewUrl);
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
          <h3>Drop image files, PSD with artboards, or a ZIP archive</h3>
          <p>Click to browse or drag and drop</p>
        </div>
        <div className="qa-dropzone-formats">
          <span className="qa-format-badge">JPG</span>
          <span className="qa-format-badge">PNG</span>
          <span className="qa-format-badge">PSD</span>
          <span className="qa-format-badge">ZIP</span>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".jpg,.jpeg,.png,.psd,.zip"
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

        {/* Content & Spelling Analysis */}
        <div className="qa-content-card qa-fade-in qa-stagger-2">
          <h4>
            Content & Spelling Analysis
            <StatusBadge status={status} count={spellingIssues.length} />
          </h4>

          {/* OCR / Text Confidence */}
          {ocrResult.text && (
            <div className="qa-ocr-confidence">
              <span className="qa-spec-label" style={{ minWidth: 70 }}>
                {metadata.format.includes('PSD') ? 'Text Confidence' : 'OCR Confidence'}
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
// Multi-Image Report
// ============================================

interface MultiImageReportProps {
  analyses: ImageAnalysis[];
  expandedRow: string | null;
  onExpandRow: (id: string | null) => void;
}

function MultiImageReport({ analyses, expandedRow, onExpandRow }: MultiImageReportProps) {
  const totalSize = analyses.reduce((sum, a) => sum + a.metadata.fileSize, 0);
  const passCount = analyses.filter((a) => a.status === 'pass').length;
  const flaggedCount = analyses.filter((a) => a.status === 'flagged').length;
  const noTextCount = analyses.filter((a) => a.status === 'no-text').length;

  const formatSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <>
      {/* Summary Stats */}
      <div className="qa-multi-summary">
        <div className="qa-summary-stat qa-fade-in">
          <span className="stat-value">{analyses.length}</span>
          <span className="stat-label">Total Images</span>
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

      {/* Image Table */}
      <div className="qa-image-table qa-fade-in qa-stagger-4">
        <div className="qa-table-header">
          <span></span>
          <span>File Name</span>
          <span>Dimensions</span>
          <span>Format & Size</span>
          <span>Status</span>
        </div>

        {analyses.map((analysis) => (
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
