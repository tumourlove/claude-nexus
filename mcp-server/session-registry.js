class SessionRegistry {
  constructor() {
    this.sessions = new Map();
    this.subscriptions = new Map(); // sessionId -> Set<channelPattern>
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

  addSubscription(sessionId, channelPattern) {
    if (!this.subscriptions.has(sessionId)) {
      this.subscriptions.set(sessionId, new Set());
    }
    this.subscriptions.get(sessionId).add(channelPattern);
  }

  removeSubscription(sessionId, channelPattern) {
    const subs = this.subscriptions.get(sessionId);
    if (subs) {
      subs.delete(channelPattern);
      if (subs.size === 0) this.subscriptions.delete(sessionId);
    }
  }

  getSubscriptions(sessionId) {
    return [...(this.subscriptions.get(sessionId) || [])];
  }

  clearSubscriptions(sessionId) {
    this.subscriptions.delete(sessionId);
  }
}

module.exports = { SessionRegistry };
