const { contextBridge, ipcRenderer, clipboard, nativeImage, shell } = require('electron');

// Helper: register listener and return unsubscribe function
function onIpc(channel, cb) {
  const handler = (_e, d) => cb(d);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('nexus', {
  // Clipboard
  clipboardReadText: () => clipboard.readText(),
  clipboardWriteText: (text) => clipboard.writeText(text),
  clipboardHasImage: () => !clipboard.readImage().isEmpty(),
  saveClipboardImage: () => ipcRenderer.invoke('clipboard:save-image'),
  openExternal: (url) => shell.openExternal(url),

  createSession: (id, label, options = {}) =>
    ipcRenderer.send('session:create', { id, label, ...options }),
  closeSession: (id) => ipcRenderer.send('session:close', { id }),
  terminalWrite: (id, data) => ipcRenderer.send('terminal:write', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
  onTerminalData: (id, callback) => onIpc(`terminal:data:${id}`, callback),
  offTerminalData: (id) => ipcRenderer.removeAllListeners(`terminal:data:${id}`),
  onSessionExited: (callback) => ipcRenderer.on('session:exited', (_e, data) => callback(data)),
  onSessionCreated: (callback) => ipcRenderer.on('session:created', (_e, data) => callback(data)),
  onSessionStatus: (callback) => ipcRenderer.on('session:status', (_e, data) => callback(data)),
  onSpawnRequested: (callback) => ipcRenderer.on('session:spawn-requested', (_e, data) => callback(data)),
  onSessionRelabeled: (callback) => ipcRenderer.on('session:relabeled', (_e, data) => callback(data)),
  onToast: (callback) => ipcRenderer.on('notification:toast', (_e, data) => callback(data)),
  getSessionHistory: (id, lines) => ipcRenderer.invoke('session:history', { id, lines }),
  browseForFolder: () => ipcRenderer.invoke('dialog:open-folder'),
  getStartupCwd: () => ipcRenderer.invoke('app:startup-cwd'),
  listSessions: () => ipcRenderer.invoke('session:list'),

  // Session controls
  cancelSession: (id) => ipcRenderer.send('session:cancel', { id }),
  restartSession: (id) => ipcRenderer.send('session:restart', { id }),
  sendQuickMessage: (id, text) => ipcRenderer.send('session:send-quick-message', { id, text }),
  broadcastMessage: (text) => ipcRenderer.send('session:broadcast-message', { text }),
  updateClaude: () => ipcRenderer.invoke('app:update-claude'),
  onOutputPreview: (cb) => onIpc('session:output-preview', cb),
  onStuckWarning: (cb) => onIpc('session:stuck-warning', cb),
  onSessionResult: (cb) => onIpc('session:result', cb),
  onAllWorkersComplete: (cb) => onIpc('workers:all-complete', cb),
  retrySession: (id, originalInfo) => ipcRenderer.send('session:retry', { id, originalInfo }),
  onRetryAvailable: (cb) => onIpc('session:retry-available', cb),
  onSessionHeartbeat: (cb) => ipcRenderer.on('session:heartbeat', (_e, data) => cb(data)),
  onTasksUpdated: (cb) => ipcRenderer.on('tasks:updated', (_e, data) => cb(data)),
  onSessionProgress: (cb) => ipcRenderer.on('session:progress', (_e, data) => cb(data)),
  onChatMessage: (cb) => ipcRenderer.on('chat:message', (_e, data) => cb(data)),

  // Session actions
  duplicateSession: (id) => ipcRenderer.invoke('session:duplicate', { id }),
  getSessionInfo: (id) => ipcRenderer.invoke('session:info', { id }),

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
