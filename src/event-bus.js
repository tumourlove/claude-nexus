class EventBus {
  constructor() {
    this.subscriptions = new Map(); // channelPattern -> Set<sessionId>
  }

  subscribe(sessionId, channelPattern) {
    if (!this.subscriptions.has(channelPattern)) {
      this.subscriptions.set(channelPattern, new Set());
    }
    this.subscriptions.get(channelPattern).add(sessionId);
  }

  unsubscribe(sessionId, channelPattern) {
    const subs = this.subscriptions.get(channelPattern);
    if (subs) {
      subs.delete(sessionId);
      if (subs.size === 0) this.subscriptions.delete(channelPattern);
    }
  }

  unsubscribeAll(sessionId) {
    for (const [pattern, subs] of this.subscriptions) {
      subs.delete(sessionId);
      if (subs.size === 0) this.subscriptions.delete(pattern);
    }
  }

  publish(channel, data, sourceSessionId) {
    const subscribers = this.getSubscribers(channel);
    // Exclude the source session from receiving its own event
    const targets = subscribers.filter(id => id !== sourceSessionId);
    return targets;
  }

  getSubscribers(channel) {
    const result = new Set();
    for (const [pattern, subs] of this.subscriptions) {
      if (this._matches(pattern, channel)) {
        for (const id of subs) result.add(id);
      }
    }
    return [...result];
  }

  _matches(pattern, channel) {
    if (pattern === channel) return true;
    if (pattern.endsWith('*')) {
      return channel.startsWith(pattern.slice(0, -1));
    }
    return false;
  }
}

module.exports = { EventBus };
