class MessageBus {
  constructor({ maxInboxSize = 100 } = {}) {
    this.messages = new Map(); // sessionId -> message[]
    this.results = new Map();  // sessionId -> result
    this.nextMsgId = 1;
    this.maxInboxSize = maxInboxSize;
  }

  send(fromId, toId, message, priority = 'normal', { type, subject, data } = {}) {
    const msg = {
      id: this.nextMsgId++,
      from: fromId,
      to: toId,
      message,
      priority,
      timestamp: Date.now(),
      read: false,
    };

    // Structured message fields (optional)
    if (type) msg.type = type;
    if (subject) msg.subject = subject;
    if (data) msg.data = data;

    if (!this.messages.has(toId)) {
      this.messages.set(toId, []);
    }
    const inbox = this.messages.get(toId);
    inbox.push(msg);

    // Evict oldest messages when inbox exceeds cap
    if (inbox.length > this.maxInboxSize) {
      inbox.splice(0, inbox.length - this.maxInboxSize);
    }

    return msg;
  }

  broadcast(fromId, message, allSessionIds) {
    const sent = [];
    for (const targetId of allSessionIds) {
      if (targetId !== fromId) {
        sent.push(this.send(fromId, targetId, message, 'normal'));
      }
    }
    return sent;
  }

  read(sessionId, { sinceTimestamp, limit = 50, type } = {}) {
    const inbox = this.messages.get(sessionId) || [];
    let filtered = inbox;

    if (sinceTimestamp) {
      filtered = filtered.filter(m => m.timestamp > sinceTimestamp);
    }

    if (type) {
      filtered = filtered.filter(m => m.type === type);
    }

    const result = filtered.slice(-limit);
    // Mark as read
    result.forEach(m => { m.read = true; });
    return result;
  }

  getUnreadCount(sessionId) {
    const inbox = this.messages.get(sessionId) || [];
    return inbox.filter(m => !m.read).length;
  }

  reportResult(sessionId, result, status) {
    this.results.set(sessionId, { result, status, timestamp: Date.now() });
  }

  getResult(sessionId) {
    return this.results.get(sessionId) || null;
  }

  // Prune all inboxes: evict oldest messages beyond maxInboxSize
  prune() {
    let pruned = 0;
    for (const [, inbox] of this.messages) {
      if (inbox.length > this.maxInboxSize) {
        const excess = inbox.length - this.maxInboxSize;
        inbox.splice(0, excess);
        pruned += excess;
      }
    }
    return pruned;
  }
}

module.exports = { MessageBus };
