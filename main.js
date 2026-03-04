const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { SessionManager } = require('./src/session-manager');

let mainWindow;
let sessionManager;

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

ipcMain.handle('session:list', () => {
  return sessionManager.listSessions();
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (sessionManager) sessionManager.destroy();
  app.quit();
});
