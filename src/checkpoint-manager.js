const fs = require('fs');
const path = require('path');
const os = require('os');

class CheckpointManager {
  constructor() {
    this.checkpointDir = path.join(os.homedir(), '.claude-corroboree', 'checkpoints');
    this.pidFile = path.join(os.homedir(), '.claude-corroboree', 'nexus.pid');
    this.maxCheckpointsPerSession = 3;
    this._timer = null;
    fs.mkdirSync(this.checkpointDir, { recursive: true });
  }

  startAutoCheckpoint(sessionManager, intervalMs = 5 * 60 * 1000) {
    this._timer = setInterval(() => {
      this._saveAll(sessionManager);
    }, intervalMs);
  }

  _saveAll(sessionManager) {
    // Access raw sessions to get outputBuffer (listSessions strips it)
    for (const [id, session] of sessionManager.sessions) {
      if (session.status === 'done' || session.status === 'failed') continue;
      this.save(session);
    }
  }

  save(session) {
    const checkpoint = {
      id: session.id,
      label: session.label,
      template: session.template,
      cwd: session.cwd,
      initialPrompt: session.initialPrompt,
      status: session.status,
      isLead: session.isLead,
      retryCount: session.retryCount || 0,
      outputTail: (session.outputBuffer || []).slice(-100).join(''),
      savedAt: Date.now(),
    };

    const filename = `${session.id}-${Date.now()}.json`;
    const filepath = path.join(this.checkpointDir, filename);

    try {
      fs.writeFileSync(filepath, JSON.stringify(checkpoint, null, 2));
    } catch (e) {
      // Ignore write errors
    }

    // Prune old checkpoints for this session
    this._pruneSession(session.id);
  }

  _pruneSession(sessionId) {
    try {
      const files = fs.readdirSync(this.checkpointDir)
        .filter(f => f.startsWith(sessionId + '-') && f.endsWith('.json'))
        .sort()
        .reverse();
      // Keep only the most recent N
      for (const file of files.slice(this.maxCheckpointsPerSession)) {
        fs.unlinkSync(path.join(this.checkpointDir, file));
      }
    } catch (e) {
      // Ignore
    }
  }

  getRecoverable() {
    try {
      const files = fs.readdirSync(this.checkpointDir).filter(f => f.endsWith('.json'));
      const sessions = new Map(); // sessionId -> latest checkpoint

      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.checkpointDir, file), 'utf8'));
          const existing = sessions.get(data.id);
          if (!existing || data.savedAt > existing.savedAt) {
            sessions.set(data.id, data);
          }
        } catch (e) { /* skip corrupt files */ }
      }

      return [...sessions.values()].filter(s => s.status !== 'done');
    } catch (e) {
      return [];
    }
  }

  writePidFile() {
    try {
      fs.writeFileSync(this.pidFile, String(process.pid));
    } catch (e) { /* ignore */ }
  }

  checkUncleanShutdown() {
    try {
      if (fs.existsSync(this.pidFile)) {
        const oldPid = parseInt(fs.readFileSync(this.pidFile, 'utf8'), 10);
        // Check if old process is still running
        try {
          process.kill(oldPid, 0); // signal 0 = just check if process exists
          return false; // Still running, not a crash
        } catch (e) {
          // Process doesn't exist = unclean shutdown
          return true;
        }
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  clearCheckpoints() {
    try {
      const files = fs.readdirSync(this.checkpointDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        fs.unlinkSync(path.join(this.checkpointDir, file));
      }
    } catch (e) { /* ignore */ }
  }

  removePidFile() {
    try {
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }
    } catch (e) { /* ignore */ }
  }

  destroy() {
    if (this._timer) clearInterval(this._timer);
    this.removePidFile();
  }
}

module.exports = { CheckpointManager };
