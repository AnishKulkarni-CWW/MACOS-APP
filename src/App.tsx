import { useState, useRef, useEffect } from 'react';
import logo from './assets/images/logo.png';
import mockupPreview from './assets/images/mockup_preview.png';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { DealersDatabase } from './components/DealersDatabase';
import { QaModule } from './components/QaModule';
import './App.css';

type ModuleType = 'designer' | 'developer' | 'qa';

function App() {
  const [activeModule, setActiveModule] = useState<ModuleType>('designer');

  const handleRefresh = () => {
    const electronAPI = (window as any).electronAPI;
    if (electronAPI?.reloadApp) {
      electronAPI.reloadApp();
    } else {
      window.location.reload();
    }
  };

  return (
    <div className="app-container">
      {/* Top Window Drag Region & Refresh Action */}
      <div className="window-drag-bar">
        <div className="window-actions">
          <button 
            className="btn-refresh" 
            onClick={handleRefresh}
            title="Refresh entire app"
            id="btn-refresh-app"
          >
            <svg 
              width="13" 
              height="13" 
              viewBox="0 0 24 24" 
              fill="none" 
              stroke="currentColor" 
              strokeWidth="2.2" 
              strokeLinecap="round" 
              strokeLinejoin="round"
            >
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
            </svg>
            <span>Refresh App</span>
          </button>
        </div>
      </div>

      {/* Sidebar Navigation */}
      <nav className="sidebar">
        <div className="brand-logo">
          <img src={logo} alt="BMW Logo" className="logo-img" />
        </div>
        <div className="nav-links">
          <div 
            className={`nav-item ${activeModule === 'designer' ? 'active' : ''}`}
            onClick={() => setActiveModule('designer')}
          >
            Designer Tools
          </div>
          <div 
            className={`nav-item ${activeModule === 'developer' ? 'active' : ''}`}
            onClick={() => setActiveModule('developer')}
          >
            Developer Tools
          </div>
          <div 
            className={`nav-item ${activeModule === 'qa' ? 'active' : ''}`}
            onClick={() => setActiveModule('qa')}
          >
            QA Evaluation
          </div>
        </div>

        {/* Sidebar Footer with Refresh */}
        <div className="sidebar-footer">
          <button 
            className="sidebar-refresh-btn" 
            onClick={handleRefresh}
            title="Refresh entire application"
          >
            <svg 
              width="13" 
              height="13" 
              viewBox="0 0 24 24" 
              fill="none" 
              stroke="currentColor" 
              strokeWidth="2.2" 
              strokeLinecap="round" 
              strokeLinejoin="round"
            >
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
            </svg>
            <span>Refresh App</span>
          </button>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="main-content">
        {activeModule === 'designer' && (
          <DesignerModule />
        )}
        {activeModule === 'developer' && (
          <DeveloperModule />
        )}
        {activeModule === 'qa' && (
          <QaModule />
        )}
      </main>
    </div>
  );
}

// Temporary inline components for modules (to be separated later)
function DesignerModule() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileMetadata, setFileMetadata] = useState<{ dimensions?: string; layers?: string }>({});
  
  // Illustrator Integration State
  const [aiLayers, setAiLayers] = useState<any[]>([]);
  const [isSyncingLayers, setIsSyncingLayers] = useState(false);
  const [targetLayerId, setTargetLayerId] = useState<string | null>(null);
  const [selectedDealers, setSelectedDealers] = useState<string[]>([]);
  const [aiDocSize, setAiDocSize] = useState<{w: number, h: number} | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let isCancelled = false;
    
    const processFile = async () => {
      if (!selectedFile) return;
      try {
        if (selectedFile.name.toLowerCase().endsWith('.psd') || selectedFile.name.toLowerCase().endsWith('.psb')) {
          const { readPsd } = await import('ag-psd');
          const buffer = await selectedFile.arrayBuffer();
          const psd = readPsd(buffer);
          if (!isCancelled) {
            setPreviewUrl(psd.canvas?.toDataURL() || null);
            setFileMetadata({
              dimensions: `${psd.width} x ${psd.height} px`,
              layers: `${psd.children ? psd.children.length : 0} Top-level Layers`
            });
          }
        } else if (selectedFile.name.toLowerCase().endsWith('.ai')) {
          let dataUrl = null;
          let isHighRes = false;
          let pdfErrorMsg = "";

          // ATTEMPT 1: PDF Vector Stream (Highest Quality)
          // This requires the AI file to be saved with "Create PDF Compatible File".
          try {
            const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
            pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
            
            const arrayBuffer = await selectedFile.arrayBuffer();
            const pdf = await (pdfjsLib.getDocument as any)({ data: new Uint8Array(arrayBuffer) }).promise;
            const page = await pdf.getPage(1);
            
            // Render at a higher scale for a crisp preview
            const viewport = page.getViewport({ scale: 2.0 });
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            if (context) {
              canvas.height = viewport.height;
              canvas.width = viewport.width;
              await (page.render as any)({ canvasContext: context, viewport, canvas }).promise;
              dataUrl = canvas.toDataURL();
              isHighRes = true;
            }
          } catch (pdfErr: any) {
            console.warn("PDF Vector extraction failed:", pdfErr);
            pdfErrorMsg = pdfErr.message || String(pdfErr);
          }

          // ATTEMPT 2: XMP Thumbnail Fallback (Low Quality, 256px)
          // If the file is not PDF compatible, we extract the embedded XMP JPEG thumbnail.
          if (!dataUrl) {
            try {
              const text = await selectedFile.text();
              const match = text.match(/<(?:xmpGImg|xapGImg):image[^>]*>(.*?)<\/(?:xmpGImg|xapGImg):image>/s);
              if (match && match[1]) {
                 let b64 = match[1].replace(/&#x[A-F0-9]+;/gi, '').replace(/\s/g, '');
                 b64 = b64.replace(/[^A-Za-z0-9+/=]/g, '');
                 dataUrl = `data:image/jpeg;base64,${b64}`;
              }
            } catch (xmpErr) {
              console.warn("XMP extraction failed:", xmpErr);
            }
          }

          if (dataUrl && !isCancelled) {
            setPreviewUrl(dataUrl);
            setFileMetadata({
              dimensions: isHighRes ? 'Crisp Vector PDF' : `PDF Err: ${pdfErrorMsg.substring(0, 40)}`,
              layers: isHighRes ? 'Artboard Extracted' : 'Not PDF Compatible'
            });
            return;
          }

          if (!isCancelled) {
            throw new Error("No image data could be extracted from this AI file.");
          }
        }
      } catch (err: any) {
        console.error("Error parsing file:", err);
        if (!isCancelled) {
          setPreviewUrl('error');
          setFileMetadata({
            dimensions: 'Parse Error',
            layers: err.message || 'Could not extract artwork'
          });
        }
      }
    };
    
    processFile();
    
    return () => { isCancelled = true; };
  }, [selectedFile]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (isProcessing && progress < 100) {
      interval = setInterval(() => {
        setProgress(prev => {
          if (prev >= 90 && !previewUrl) return prev; // Wait for parsing
          
          const next = prev + Math.floor(Math.random() * 5) + 5; // Fast progress
          if (next >= 100) {
            if (previewUrl) {
              setIsProcessing(false);
              return 100;
            }
            return 99; // Hang at 99 until parsed
          }
          return next;
        });
      }, 100);
    }
    return () => clearInterval(interval);
  }, [isProcessing, progress, previewUrl]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFile(e.target.files[0]);
      setPreviewUrl(null);
      setFileMetadata({});
      setAiLayers([]);
      setTargetLayerId(null);
      setAiDocSize(null);
      setIsProcessing(true);
      setProgress(0);
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  if (selectedFile) {
    return (
      <div className="psd-preview-container">
        <div className="psd-preview-header">
          <button className="btn-secondary" onClick={() => setSelectedFile(null)}>← Back</button>
          <h2>{selectedFile.name}</h2>
        </div>
        <div className="psd-split-view">
          <div className="psd-preview-section glass-panel">
            {isProcessing ? (
              <div className="psd-loader">
                <div className="spinner"></div>
                <p>Analyzing Master Design...</p>
                <div className="progress-bar-container">
                  <div className="progress-bar-fill" style={{ width: `${progress}%` }}></div>
                </div>
                <div className="progress-stats">
                  <span>{progress}% Complete</span>
                  <span>Time remaining: {Math.max(1, Math.ceil((100 - progress) / 20))}s</span>
                </div>
              </div>
            ) : (
              <div className="psd-artwork-preview" style={{ backgroundColor: 'transparent', border: '1px solid var(--glass-border)' }}>
                {previewUrl === 'error' ? (
                   <div className="psd-placeholder">
                     <span className="icon">⚠️</span>
                     <p>Failed to extract artwork</p>
                     <small>macOS native QuickLook could not read the file.</small>
                   </div>
                ) : previewUrl ? (
                   <img src={previewUrl} alt="Artwork Preview" className="artwork-image" style={{ objectFit: 'contain' }} />
                ) : (
                   <img src={mockupPreview} alt="Artwork Preview" className="artwork-image" style={{ objectFit: 'contain' }} />
                )}
                
                {/* Illustrator Layers Interactive Overlay */}
                {aiLayers.length > 0 && aiDocSize && (
                  <svg 
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 10 }}
                    viewBox={`0 0 ${aiDocSize.w} ${aiDocSize.h}`}
                    preserveAspectRatio="xMidYMid meet"
                  >
                    {aiLayers.map((layer) => (
                      <rect
                        key={layer.id}
                        x={layer.bounds.left}
                        y={layer.bounds.top}
                        width={layer.bounds.width}
                        height={layer.bounds.height}
                        fill={targetLayerId === layer.id ? "rgba(0, 255, 0, 0.3)" : "rgba(0, 102, 177, 0.2)"}
                        stroke={targetLayerId === layer.id ? "#00ff00" : "#0066b1"}
                        strokeWidth="4"
                        pointerEvents="all"
                        style={{ cursor: 'pointer', transition: 'all 0.2s' }}
                        onClick={() => setTargetLayerId(layer.id)}
                        onMouseEnter={(e) => {
                          if (targetLayerId !== layer.id) e.currentTarget.setAttribute('fill', 'rgba(0, 102, 177, 0.4)');
                        }}
                        onMouseLeave={(e) => {
                          if (targetLayerId !== layer.id) e.currentTarget.setAttribute('fill', 'rgba(0, 102, 177, 0.2)');
                        }}
                      >
                        <title>{layer.name}: {layer.content}</title>
                      </rect>
                    ))}
                  </svg>
                )}

                <div className="artwork-overlay">
                  <span className="icon">✅</span>
                  <span>{selectedFile.name} loaded successfully</span>
                </div>
              </div>
            )}
          </div>
          <div className="psd-metadata-section glass-panel">
            <h3>Metadata</h3>
            <div className="metadata-list">
              <div className="metadata-item">
                <span className="label">File Name</span>
                <span className="value">{selectedFile.name}</span>
              </div>
              <div className="metadata-item">
                <span className="label">File Size</span>
                <span className="value">{(selectedFile.size / (1024 * 1024)).toFixed(2)} MB</span>
              </div>
              <div className="metadata-item">
                <span className="label">Last Modified</span>
                <span className="value">{new Date(selectedFile.lastModified).toLocaleString()}</span>
              </div>
              <div className="metadata-item">
                <span className="label">Type</span>
                <span className="value">
                  {selectedFile.name.toLowerCase().endsWith('.psb') ? 'Large Document Format (PSB)' : 
                   selectedFile.name.toLowerCase().endsWith('.ai') ? 'Adobe Illustrator (AI)' : 
                   'Photoshop Document (PSD)'}
                </span>
              </div>
              <div className="metadata-item">
                <span className="label">Dimensions</span>
                <span className="value">{isProcessing || !fileMetadata.dimensions ? 'Pending Analysis...' : fileMetadata.dimensions}</span>
              </div>
              <div className="metadata-item">
                <span className="label">Layers</span>
                <span className="value">{isProcessing || !fileMetadata.layers ? 'Pending Analysis...' : fileMetadata.layers}</span>
              </div>
            </div>
            
            {selectedFile.name.toLowerCase().endsWith('.ai') && (
              <div style={{ marginTop: '16px' }}>
                <button 
                  className="btn-secondary" 
                  style={{ width: '100%', marginBottom: '16px' }}
                  onClick={async () => {
                    setIsSyncingLayers(true);
                    try {
                      const res = await (window as any).electronAPI.getIllustratorLayers();
                      if (res && res.success) {
                        setAiLayers(res.layers);
                        setAiDocSize({ w: res.docWidth, h: res.docHeight });
                      } else {
                        alert(res.error || "Failed to fetch layers. Ensure Illustrator is open with the document.");
                      }
                    } catch (e: any) {
                      alert("Error communicating with Illustrator: " + e.message);
                    }
                    setIsSyncingLayers(false);
                  }}
                  disabled={isSyncingLayers}
                >
                  {isSyncingLayers ? 'Syncing...' : 'Sync Layers from Illustrator'}
                </button>
              </div>
            )}

            {aiLayers.length > 0 && (
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                {targetLayerId ? (
                  <div style={{ color: '#4ade80' }}>✓ Target text block selected</div>
                ) : (
                  <div>Hover over the preview and click a highlighted text block to select it as the dealer target.</div>
                )}
              </div>
            )}

            <DealersDatabase onSelect={setSelectedDealers} />

            <button 
              className="btn-primary generate-btn" 
              style={{ marginTop: 'auto', width: '100%', alignSelf: 'stretch' }} 
              disabled={isProcessing || (selectedFile.name.toLowerCase().endsWith('.ai') && (!targetLayerId || selectedDealers.length === 0))}
              onClick={async () => {
                setIsProcessing(true);
                try {
                  const { MOCK_DEALERS } = await import('./components/DealersDatabase');
                  const selectedDealerData = MOCK_DEALERS.filter(d => selectedDealers.includes(d.id));
                  
                  const res = await (window as any).electronAPI.generateIllustratorVariations({
                    targetLayerId,
                    dealers: selectedDealerData
                  });
                  
                  if (res && res.success) {
                    alert(`Successfully generated ${res.files.length} variations!\\n\\nSaved to: Desktop/BMW_Generated_Ads/`);
                  } else {
                    alert("Error generating variations: " + (res?.error || "Unknown error"));
                  }
                } catch (e: any) {
                  alert("Failed to communicate with Illustrator: " + e.message);
                }
                setIsProcessing(false);
              }}
            >
              {isProcessing ? 'Processing...' : 'Generate AI Variations'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="module-header">
        <h1>Designer Tools</h1>
        <p>Automate static adapts from master PSD/PSB/AI files.</p>
      </div>
      <div className="content-grid">
        <div className="glass-panel dashboard-card">
          <h3>Process Master File</h3>
          <p>Select a master design file to generate all required static variations automatically.</p>
          <input 
            type="file" 
            accept=".psd,.psb,.ai" 
            ref={fileInputRef} 
            style={{ display: 'none' }} 
            onChange={handleFileSelect}
          />
          <button className="btn-primary" style={{ marginTop: 'auto' }} onClick={triggerFileInput}>
            Select File
          </button>
        </div>
        <div className="glass-panel dashboard-card">
          <h3>Asset Library</h3>
          <p>Manage and view imported assets and campaign Zips.</p>
          <button className="btn-primary" style={{ marginTop: 'auto' }}>Open Library</button>
        </div>
      </div>
    </div>
  );
}

function DeveloperModule() {
  return (
    <div>
      <div className="module-header">
        <h1>Developer Tools</h1>
        <p>Rapidly construct and generate BMW EDMs.</p>
      </div>
      <div className="content-grid">
        <div className="glass-panel dashboard-card">
          <h3>New EDM Campaign</h3>
          <p>Initialize a new Email Direct Marketing project with standard BMW templates.</p>
          <button className="btn-primary" style={{ marginTop: 'auto' }}>Create Campaign</button>
        </div>
      </div>
    </div>
  );
}

// QaModule is now imported from ./components/QaModule

export default App;
