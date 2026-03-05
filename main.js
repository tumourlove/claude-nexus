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

// Single-instance lock — prevent data corruption from multiple Nexus instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
const os = require('os');
const { SessionManager } = require('./src/session-manager');
const { IpcServer } = require('./src/ipc-server');
const { Scratchpad } = require('./src/scratchpad');
const { HistoryManager } = require('./src/history-manager');
const { ConflictDetector } = require('./src/conflict-detector');
const { NotificationManager } = require('./src/notification-manager');
const { TaskQueue } = require('./src/task-queue');
const { CheckpointManager } = require('./src/checkpoint-manager');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let sessionManager;
let ipcServer;
let scratchpad;
let historyManager;
let conflictDetector;
let notificationManager;
let taskQueue;
let checkpointManager;
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
  taskQueue = new TaskQueue();
  historyManager = new HistoryManager();
  conflictDetector = new ConflictDetector();
  notificationManager = new NotificationManager(mainWindow);
  checkpointManager = new CheckpointManager();
  checkpointManager.writePidFile();
  checkpointManager.startAutoCheckpoint(sessionManager);

  // Capture terminal output for history
  sessionManager.onOutput = (id, data) => {
    historyManager.appendOutput(id, data);
  };

  ipcServer = new IpcServer({
    sessionManager,
    scratchpad,
    historyManager,
    conflictDetector,
    taskQueue,
    onSpawnRequest: ({ cwd, initialPrompt, label, template, requestedBy }) => {
      tabCounter++;
      const id = `worker-${tabCounter}`;
      // Tell renderer to create the tab
      mainWindow.webContents.send('session:spawn-requested', {
        id, label, cwd, initialPrompt, template,
      });
      return id;
    },
  });

  ipcServer.start();

  // Notify lead sessions when a worker exhausts all retries
  sessionManager.ipcNotifyCallback = (msg) => {
    if (msg.type === 'worker_failed') {
      for (const [id, socket] of ipcServer.clients) {
        const session = sessionManager.getSessionInfo(id);
        if (session && session.isLead) {
          ipcServer._reply(socket, {
            type: 'message',
            from: msg.sessionId,
            message: `[WORKER_FAILED] Session ${msg.label || msg.sessionId} exhausted ${msg.retryCount} retries`,
            priority: 'urgent',
          });
        }
      }
    }
  };
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

ipcMain.on('chat:broadcast', (_event, text) => {
  // Forward to all sessions via IPC server
  if (ipcServer) {
    for (const [id, socket] of ipcServer.clients) {
      ipcServer._reply(socket, {
        type: 'message',
        from: 'user',
        message: text,
        priority: 'normal',
      });
    }
  }
  // Echo back to renderer for chat panel display
  mainWindow.webContents.send('chat:message', { from: 'You', message: text, priority: 'normal' });
});

ipcMain.handle('app:update-claude', () => {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec('claude update', { encoding: 'utf8', timeout: 30000 }, (err, stdout) => {
      if (err) resolve({ success: false, output: err.message });
      else resolve({ success: true, output: stdout });
    });
  });
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

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow.webContents.send('updater:ready');
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `Claude Nexus v${info.version} has been downloaded.`,
      detail: 'Restart now to apply the update?',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
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

// Register shell integration on first launch of packaged build
function registerShellIfNeeded() {
  if (!app.isPackaged) return;
  const flagPath = path.join(os.homedir(), '.claude-nexus', 'shell-registered-version');
  const currentVersion = app.getVersion();
  try {
    const registered = fs.readFileSync(flagPath, 'utf8').trim();
    if (registered === currentVersion) return; // already registered for this version
  } catch { /* not registered yet */ }

  try {
    const scriptPath = path.join(process.resourcesPath, 'scripts', 'register-shell.js');
    require('child_process').execFileSync(process.execPath, [scriptPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
    });
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    fs.writeFileSync(flagPath, currentVersion);
    console.log('Shell integration registered for v' + currentVersion);
  } catch (e) {
    console.error('Failed to register shell:', e.message);
  }
}

app.whenReady().then(() => {
  // Startup self-check: validate required CLI tools
  const { execSync } = require('child_process');
  const missing = [];
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    execSync(`${whichCmd} claude`, { stdio: 'pipe', timeout: 5000 });
  } catch {
    missing.push('claude');
  }
  try {
    execSync('git --version', { stdio: 'pipe', timeout: 5000 });
  } catch {
    missing.push('git');
  }
  if (missing.length > 0) {
    dialog.showErrorBox(
      'Missing Dependencies',
      `The following required tools were not found in PATH: ${missing.join(', ')}.\n\n` +
      'Some features will not work correctly. Please install the missing tools and restart.'
    );
  }

  // Check for unclean shutdown and offer recovery
  const tempCheckpointMgr = new CheckpointManager();
  if (tempCheckpointMgr.checkUncleanShutdown()) {
    const recoverable = tempCheckpointMgr.getRecoverable();
    if (recoverable.length > 0) {
      const result = dialog.showMessageBoxSync({
        type: 'question',
        title: 'Recover Previous Sessions?',
        message: `Nexus detected an unclean shutdown. ${recoverable.length} session(s) can be recovered.`,
        detail: recoverable.map(s => `- ${s.label || s.id} (${s.template})`).join('\n'),
        buttons: ['Recover', 'Start Fresh'],
        defaultId: 0,
      });
      if (result === 1) {
        tempCheckpointMgr.clearCheckpoints();
      }
      // If recover, checkpoints stay and will be available after createWindow
    }
  }

  createWindow();
  setupAutoUpdater();
  registerShellIfNeeded();

  // Clean up orphaned worktrees from previous sessions
  const startupCwd = process.argv[2] || process.cwd();
  try {
    const activeIds = new Set(sessionManager.sessions.keys());
    sessionManager.worktreeManager.cleanupOrphans(activeIds, startupCwd);
  } catch (e) {
    console.error('Worktree orphan cleanup failed:', e.message);
  }
});
app.on('window-all-closed', () => {
  if (checkpointManager) checkpointManager.destroy();
  if (ipcServer) ipcServer.stop();
  if (scratchpad) scratchpad.destroy();
  if (ipcServer && ipcServer.knowledgeBase) ipcServer.knowledgeBase.destroy();
  if (sessionManager) sessionManager.destroy();
  app.quit();
});
