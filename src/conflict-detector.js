class ConflictDetector {
  constructor() {
    // sessionId -> Set<filepath>
    this.fileEdits = new Map();
    // filepath -> { sessionId, timestamp, intent }
    this.locks = new Map();
    // Event callback for pub/sub integration — set by IpcServer
    this.onEvent = null;
  }

  recordEdit(sessionId, filepath) {
    if (!this.fileEdits.has(sessionId)) {
      this.fileEdits.set(sessionId, new Set());
    }
    this.fileEdits.get(sessionId).add(filepath);
  }

  checkConflict(sessionId, filepath) {
    const conflicts = [];
    for (const [otherId, files] of this.fileEdits) {
      if (otherId !== sessionId && files.has(filepath)) {
        conflicts.push(otherId);
      }
    }
    return conflicts;
  }

  getSessionFiles(sessionId) {
    return [...(this.fileEdits.get(sessionId) || [])];
  }

  claimFile(sessionId, filepath, intent = 'edit') {
    const existing = this.locks.get(filepath);
    const tenMinAgo = Date.now() - 10 * 60 * 1000;

    if (existing && existing.sessionId !== sessionId && existing.timestamp > tenMinAgo) {
      return {
        conflict: true,
        lockedBy: existing.sessionId,
        intent: existing.intent,
        timestamp: existing.timestamp,
      };
    }

    this.locks.set(filepath, { sessionId, timestamp: Date.now(), intent });
    if (this.onEvent) {
      this.onEvent('file:claimed', { filepath, intent }, sessionId);
    }
    return { conflict: false };
  }

  releaseFile(sessionId, filepath) {
    const lock = this.locks.get(filepath);
    if (lock && lock.sessionId === sessionId) {
      this.locks.delete(filepath);
      if (this.onEvent) {
        this.onEvent('file:released', { filepath }, sessionId);
      }
      return true;
    }
    return false;
  }

  listLocks(sessionId) {
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const result = [];
    for (const [filepath, lock] of this.locks) {
      if (lock.timestamp < tenMinAgo) {
        this.locks.delete(filepath); // auto-clean expired
        continue;
      }
      if (!sessionId || lock.sessionId === sessionId) {
        result.push({ filepath, ...lock });
      }
    }
    return result;
  }

  clearSessionLocks(sessionId) {
    for (const [filepath, lock] of [...this.locks]) {
      if (lock.sessionId === sessionId) {
        this.locks.delete(filepath);
      }
    }
  }

  clearSession(sessionId) {
    this.fileEdits.delete(sessionId);
    this.clearSessionLocks(sessionId);
  }
}

module.exports = { ConflictDetector };
