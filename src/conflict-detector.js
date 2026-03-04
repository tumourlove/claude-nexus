class ConflictDetector {
  constructor() {
    // sessionId -> Set<filepath>
    this.fileEdits = new Map();
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

  clearSession(sessionId) {
    this.fileEdits.delete(sessionId);
  }
}

module.exports = { ConflictDetector };
