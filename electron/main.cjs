const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');

// Determine if we're running in development or production
const isDev = !app.isPackaged;

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset', // Better for macOS (sleek design)
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  if (isDev) {
    // In dev, load from Vite dev server
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // In production, load the built HTML file
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

const { getIllustratorTextLayers } = require('./illustrator-bridge.cjs');

// Native file preview using macOS QuickLook integration (works for AI, PSD, etc.)
ipcMain.handle('get-file-preview', async (event, data) => {
  const fs = require('fs');
  const { exec } = require('child_process');
  let tempFilePath = '';

  try {
    if (!data || !data.buffer) throw new Error("File buffer is missing");
    
    // Write buffer to a temporary file
    tempFilePath = path.join(app.getPath('temp'), `input_${Date.now()}_${data.name || 'file.ai'}`);
    fs.writeFileSync(tempFilePath, Buffer.from(data.buffer));
    
    // Attempt 1: nativeImage (QuickLook)
    try {
      const thumb = await nativeImage.createThumbnailFromPath(tempFilePath, { width: 1024, height: 1024 });
      if (!thumb.isEmpty()) {
        fs.unlinkSync(tempFilePath);
        return thumb.toDataURL();
      }
    } catch (e) {
      console.warn("nativeImage thumbnail failed, falling back to sips:", e.message);
    }

    // Attempt 2: sips fallback (macOS)
    return new Promise((resolve, reject) => {
      const outPath = path.join(app.getPath('temp'), `preview_${Date.now()}.png`);
      exec(`sips -s format png -Z 1024 "${tempFilePath}" --out "${outPath}"`, (error) => {
        if (error) {
          console.error("sips fallback failed:", error);
          if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
          reject(error);
          return;
        }
        try {
          const resultBuffer = fs.readFileSync(outPath);
          fs.unlinkSync(outPath);
          if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
          resolve(`data:image/png;base64,${resultBuffer.toString('base64')}`);
        } catch (readError) {
          if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
          reject(readError);
        }
      });
    });
  } catch (err) {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    console.error('Failed to create preview from buffer:', err);
    throw err;
  }
});

ipcMain.handle('get-illustrator-layers', async () => {
  const { getIllustratorTextLayers } = require('./illustrator-bridge.cjs');
  try {
    return await getIllustratorTextLayers();
  } catch (err) {
    console.error('Illustrator Bridge Error:', err);
    throw err;
  }
});

ipcMain.handle('generate-illustrator-variations', async (event, { targetLayerId, dealers }) => {
  const { generateIllustratorVariations } = require('./illustrator-bridge.cjs');
  try {
    return await generateIllustratorVariations(targetLayerId, dealers);
  } catch (err) {
    console.error('Illustrator Generation Error:', err);
    throw err;
  }
});

// Native macOS OCR using Apple Vision framework
ipcMain.handle('run-native-ocr', async (event, { buffer, fileName }) => {
  const fs = require('fs');
  const { execFile } = require('child_process');

  let tempFilePath = '';
  try {
    // Write the image buffer to a temp file
    tempFilePath = path.join(app.getPath('temp'), `ocr_${Date.now()}_${fileName || 'image.jpg'}`);
    fs.writeFileSync(tempFilePath, Buffer.from(buffer));

    // Path to the compiled OCR binary
    const ocrBinaryPath = isDev
      ? path.join(__dirname, 'ocr-vision')
      : path.join(process.resourcesPath, 'electron', 'ocr-vision');

    // Run the Vision OCR binary
    return new Promise((resolve, reject) => {
      execFile(ocrBinaryPath, [tempFilePath], { timeout: 30000 }, (error, stdout, stderr) => {
        // Clean up temp file
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

        if (error) {
          console.error('Native OCR error:', error);
          resolve({ success: false, error: error.message });
          return;
        }

        try {
          const result = JSON.parse(stdout.trim());
          resolve(result);
        } catch (parseErr) {
          console.error('OCR output parse error:', parseErr, 'stdout:', stdout);
          resolve({ success: false, error: 'Failed to parse OCR output' });
        }
      });
    });
  } catch (err) {
    if (tempFilePath && require('fs').existsSync(tempFilePath)) {
      require('fs').unlinkSync(tempFilePath);
    }
    console.error('Native OCR setup error:', err);
    return { success: false, error: err.message };
  }
});

// ============================================
// QR link validation
// ============================================
// Runs in the main process so QA link checks are not blocked by renderer CORS.

const MAX_REDIRECTS = 5;
const LINK_TIMEOUT_MS = 12000;
const LINK_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 BMWAutomationQA/1.0';

/**
 * Issue a single request and resolve with the status and any redirect target.
 * Never rejects — transport failures come back as { error }.
 */
function requestOnce(targetUrl, method) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      resolve({ error: 'Malformed URL' });
      return;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      resolve({ error: `Unsupported protocol: ${parsed.protocol}` });
      return;
    }

    const transport = parsed.protocol === 'https:' ? require('https') : require('http');

    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: {
          'User-Agent': LINK_USER_AGENT,
          Accept: '*/*',
        },
        timeout: LINK_TIMEOUT_MS,
      },
      (res) => {
        // We only need the headers; drain so the socket can be reused/closed.
        res.resume();
        resolve({ status: res.statusCode, location: res.headers.location });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({ error: `Timed out after ${LINK_TIMEOUT_MS / 1000}s` });
    });

    req.on('error', (err) => {
      resolve({ error: err.message || String(err) });
    });

    req.end();
  });
}

ipcMain.handle('check-url', async (event, url) => {
  const target = typeof url === 'string' ? url : url && url.url;
  if (!target) {
    return { ok: false, error: 'No URL supplied' };
  }

  let current = target;
  let lastStatus;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let result = await requestOnce(current, 'HEAD');

    // Plenty of servers reject HEAD outright — retry those with GET before
    // calling the link broken.
    if (
      result.error ||
      result.status === 405 ||
      result.status === 403 ||
      result.status === 501
    ) {
      const getResult = await requestOnce(current, 'GET');
      if (!getResult.error) {
        result = getResult;
      } else if (result.error) {
        return { ok: false, finalUrl: current, error: result.error };
      }
    }

    lastStatus = result.status;

    const isRedirect =
      typeof result.status === 'number' &&
      result.status >= 300 &&
      result.status < 400 &&
      result.location;

    if (!isRedirect) {
      return {
        ok: typeof result.status === 'number' && result.status < 400,
        status: result.status,
        finalUrl: current,
      };
    }

    try {
      current = new URL(result.location, current).toString();
    } catch {
      return { ok: false, status: result.status, finalUrl: current, error: 'Invalid redirect target' };
    }
  }

  return {
    ok: false,
    status: lastStatus,
    finalUrl: current,
    error: `Too many redirects (>${MAX_REDIRECTS})`,
  };
});

// App reload handler
ipcMain.handle('reload-app', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.webContents.reloadIgnoringCache();
  }
  return { success: true };
});
