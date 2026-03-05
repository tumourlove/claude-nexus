class MessageBus {
  constructor() {
    this.messages = new Map(); // sessionId -> message[]
    this.results = new Map();  // sessionId -> result
    this.nextMsgId = 1;
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
    this.messages.get(toId).push(msg);
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
}

module.exports = { MessageBus };
