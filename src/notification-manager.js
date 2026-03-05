const { Notification } = require('electron');

class NotificationManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.history = []; // last 20 notifications
  }

  notify({ title, body, type = 'info', sessionId }) {
    // Track history
    const entry = { title, body, type, sessionId, timestamp: Date.now() };
    this.history.push(entry);
    if (this.history.length > 20) this.history.shift();

    // System tray notification
    if (Notification.isSupported()) {
      const notification = new Notification({ title, body, silent: false });
      notification.show();
    }

    // In-app toast
    this.mainWindow.webContents.send('notification:toast', {
      title, body, type, sessionId, timestamp: Date.now(),
    });
  }

  getHistory() {
    return [...this.history];
  }
}

module.exports = { NotificationManager };
