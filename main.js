// Prevent unhandled errors from crashing the app
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { SessionManager } = require('./src/session-manager');
const { IpcServer } = require('./src/ipc-server');
const { Scratchpad } = require('./src/scratchpad');
const { HistoryManager } = require('./src/history-manager');
const { ConflictDetector } = require('./src/conflict-detector');
const { NotificationManager } = require('./src/notification-manager');
const { autoUpdater } = require('electron-updater');

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

ipcMain.on('session:create', (_event, { id, label, cwd, initialPrompt, template, isLead, cols, rows }) => {
  sessionManager.createSession(id, { label, cwd, initialPrompt, template, isLead, cols, rows });
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

ipcMain.on('session:cancel', (_event, { id }) => {
  sessionManager.writeToSession(id, '\x03'); // SIGINT
});

ipcMain.on('session:restart', (_event, { id }) => {
  const info = sessionManager.getSessionInfo(id);
  if (!info) return;
  sessionManager.closeSession(id);
  // Small delay so the old session fully cleans up
  setTimeout(() => {
    sessionManager.createSession(id, {
      label: info.label,
      cwd: info.cwd,
      template: info.template,
      isLead: info.isLead,
    });
  }, 500);
});

ipcMain.on('session:send-quick-message', (_event, { id, text }) => {
  if (ipcServer) {
    ipcServer.sendToSession(id, {
      type: 'message',
      from: 'user',
      message: text,
      priority: 'normal',
    });
  }
});

ipcMain.on('session:broadcast-message', (_event, { text }) => {
  if (ipcServer) {
    for (const [sid, socket] of ipcServer.clients) {
      ipcServer._reply(socket, {
        type: 'message',
        from: 'user',
        message: text,
        priority: 'normal',
      });
    }
  }
});

ipcMain.handle('app:update-claude', async () => {
  const { execSync } = require('child_process');
  try {
    const output = execSync('claude update', { encoding: 'utf8', timeout: 30000 });
    return { success: true, output };
  } catch (e) {
    return { success: false, output: e.message };
  }
});

ipcMain.on('session:retry', (_event, { id, originalInfo }) => {
  const retryPrompt = originalInfo.initialPrompt
    ? `${originalInfo.initialPrompt}\n\nNote: Previous attempt failed. Try a different approach.`
    : undefined;

  sessionManager.createSession(id, {
    label: originalInfo.label,
    cwd: originalInfo.cwd,
    template: originalInfo.template,
    isLead: originalInfo.isLead,
    initialPrompt: retryPrompt,
  });

  // Increment retry count on the new session
  const session = sessionManager.sessions.get(id);
  if (session) session.retryCount = (originalInfo.retryCount || 0) + 1;
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

// Save clipboard image to temp file and return path
ipcMain.handle('clipboard:save-image', async () => {
  const img = clipboard.readImage();
  if (img.isEmpty()) return null;
  const tmpDir = path.join(os.tmpdir(), 'claude-nexus-images');
  fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, `paste-${Date.now()}.png`);
  fs.writeFileSync(filePath, img.toPNG());
  return filePath;
});

// --- Auto-updater ---
function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    mainWindow.webContents.send('updater:available', {
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on('update-not-available', () => {
    mainWindow.webContents.send('updater:up-to-date');
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow.webContents.send('updater:progress', {
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', () => {
    mainWindow.webContents.send('updater:ready');
  });

  autoUpdater.on('error', (err) => {
    mainWindow.webContents.send('updater:error', { message: err.message });
  });

  // Check for updates after a short delay
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);
}

ipcMain.handle('updater:check', () => autoUpdater.checkForUpdates().catch(() => null));
ipcMain.handle('updater:download', () => autoUpdater.downloadUpdate().catch(() => null));
ipcMain.handle('updater:install', () => autoUpdater.quitAndInstall());
ipcMain.handle('updater:get-version', () => app.getVersion());

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();
});
app.on('window-all-closed', () => {
  if (ipcServer) ipcServer.stop();
  if (sessionManager) sessionManager.destroy();
  app.quit();
});
