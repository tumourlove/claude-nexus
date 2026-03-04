class SessionRegistry {
  constructor() {
    this.sessions = new Map();
  }

  register(sessionId, metadata = {}) {
    this.sessions.set(sessionId, {
      id: sessionId,
      status: 'idle',
      label: metadata.label || sessionId,
      template: metadata.template || 'implementer',
      registeredAt: Date.now(),
      ...metadata,
    });
  }

  unregister(sessionId) {
    this.sessions.delete(sessionId);
  }

  get(sessionId) {
    return this.sessions.get(sessionId);
  }

  list() {
    return [...this.sessions.values()];
  }

  updateStatus(sessionId, status) {
    const session = this.sessions.get(sessionId);
    if (session) session.status = status;
  }
}

module.exports = { SessionRegistry };
