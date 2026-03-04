const { Notification } = require('electron');

class NotificationManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
  }

  notify({ title, body, type = 'info', sessionId }) {
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
}

module.exports = { NotificationManager };
