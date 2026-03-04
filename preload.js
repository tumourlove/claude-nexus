const { contextBridge, ipcRenderer, clipboard, nativeImage } = require('electron');

contextBridge.exposeInMainWorld('nexus', {
  // Clipboard
  clipboardReadText: () => clipboard.readText(),
  clipboardWriteText: (text) => clipboard.writeText(text),
  clipboardHasImage: () => !clipboard.readImage().isEmpty(),
  saveClipboardImage: () => ipcRenderer.invoke('clipboard:save-image'),

  createSession: (id, label, options = {}) =>
    ipcRenderer.send('session:create', { id, label, ...options }),
  closeSession: (id) => ipcRenderer.send('session:close', { id }),
  terminalWrite: (id, data) => ipcRenderer.send('terminal:write', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
  onTerminalData: (id, callback) => ipcRenderer.on(`terminal:data:${id}`, (_e, data) => callback(data)),
  onSessionExited: (callback) => ipcRenderer.on('session:exited', (_e, data) => callback(data)),
  onSessionCreated: (callback) => ipcRenderer.on('session:created', (_e, data) => callback(data)),
  onSessionStatus: (callback) => ipcRenderer.on('session:status', (_e, data) => callback(data)),
  onSpawnRequested: (callback) => ipcRenderer.on('session:spawn-requested', (_e, data) => callback(data)),
  onToast: (callback) => ipcRenderer.on('notification:toast', (_e, data) => callback(data)),
  getSessionHistory: (id, lines) => ipcRenderer.invoke('session:history', { id, lines }),
  browseForFolder: () => ipcRenderer.invoke('dialog:open-folder'),
  getStartupCwd: () => ipcRenderer.invoke('app:startup-cwd'),
  listSessions: () => ipcRenderer.invoke('session:list'),

  // Auto-updater
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getVersion: () => ipcRenderer.invoke('updater:get-version'),
  onUpdateAvailable: (cb) => ipcRenderer.on('updater:available', (_e, d) => cb(d)),
  onUpdateUpToDate: (cb) => ipcRenderer.on('updater:up-to-date', () => cb()),
  onUpdateProgress: (cb) => ipcRenderer.on('updater:progress', (_e, d) => cb(d)),
  onUpdateReady: (cb) => ipcRenderer.on('updater:ready', () => cb()),
  onUpdateError: (cb) => ipcRenderer.on('updater:error', (_e, d) => cb(d)),
});
