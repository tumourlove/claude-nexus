const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexus', {
  createSession: (id, label, options = {}) =>
    ipcRenderer.send('session:create', { id, label, ...options }),
  closeSession: (id) => ipcRenderer.send('session:close', { id }),
  terminalWrite: (id, data) => ipcRenderer.send('terminal:write', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
  onTerminalData: (id, callback) => ipcRenderer.on(`terminal:data:${id}`, (_e, data) => callback(data)),
  onSessionExited: (callback) => ipcRenderer.on('session:exited', (_e, data) => callback(data)),
  onSessionCreated: (callback) => ipcRenderer.on('session:created', (_e, data) => callback(data)),
  onSessionStatus: (callback) => ipcRenderer.on('session:status', (_e, data) => callback(data)),
  listSessions: () => ipcRenderer.invoke('session:list'),
});
