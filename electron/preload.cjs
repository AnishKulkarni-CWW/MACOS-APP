const { contextBridge, ipcRenderer } = require('electron')

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  ping: () => ipcRenderer.invoke('ping'),
  getFilePreview: (filePath) => ipcRenderer.invoke('get-file-preview', filePath),
  getIllustratorLayers: () => ipcRenderer.invoke('get-illustrator-layers'),
  generateIllustratorVariations: (data) => ipcRenderer.invoke('generate-illustrator-variations', data),
  runNativeOCR: (data) => ipcRenderer.invoke('run-native-ocr', data),
  checkUrl: (url) => ipcRenderer.invoke('check-url', url),
  reloadApp: () => ipcRenderer.invoke('reload-app')
})
