// Prevent unhandled errors from crashing the app
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { SessionManager } = require('./src/session-manager');
const { IpcServer } = require('./src/ipc-server');
const { Scratchpad } = require('./src/scratchpad');
const { HistoryManager } = require('./src/history-manager');
const { ConflictDetector } = require('./src/conflict-detector');
const { NotificationManager } = require('./src/notification-manager');

let mainWindow;
let sessionManager;
let ipcServer;
let scratchpad;
let historyManager;
let conflictDetector;
let notificationManager;
let tabCounter = 0;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');

  sessionManager = new SessionManager(mainWindow);
  scratchpad = new Scratchpad();
  historyManager = new HistoryManager();
  conflictDetector = new ConflictDetector();
  notificationManager = new NotificationManager(mainWindow);

  // Capture terminal output for history
  sessionManager.onOutput = (id, data) => {
    historyManager.appendOutput(id, data);
  };

  ipcServer = new IpcServer({
    sessionManager,
    scratchpad,
    historyManager,
    conflictDetector,
    onSpawnRequest: ({ cwd, initialPrompt, label, template, requestedBy }) => {
      tabCounter++;
      const id = `tab-${tabCounter}`;
      // Tell renderer to create the tab
      mainWindow.webContents.send('session:spawn-requested', {
        id, label, cwd, initialPrompt, template,
      });
    },
  });

  ipcServer.start();
}

ipcMain.on('session:create', (_event, { id, label, cwd, initialPrompt, template, isLead }) => {
  sessionManager.createSession(id, { label, cwd, initialPrompt, template, isLead });
});

ipcMain.on('session:close', (_event, { id }) => {
  sessionManager.closeSession(id);
});

ipcMain.on('terminal:write', (_event, { id, data }) => {
  sessionManager.writeToSession(id, data);
});

ipcMain.on('terminal:resize', (_event, { id, cols, rows }) => {
  sessionManager.resizeSession(id, cols, rows);
});

ipcMain.handle('session:list', () => sessionManager.listSessions());

ipcMain.handle('session:history', (_event, { id, lines }) => {
  return historyManager.getRecentOutput(id, lines || 100);
});

ipcMain.handle('dialog:open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Project Folder',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Returns null if a directory was passed as CLI arg, or the startup cwd for picker mode
ipcMain.handle('app:startup-cwd', () => {
  return process.argv[2] || null;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (ipcServer) ipcServer.stop();
  if (sessionManager) sessionManager.destroy();
  app.quit();
});
