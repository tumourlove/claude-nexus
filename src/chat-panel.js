class ChatPanel {
  constructor() {
    this.messages = [];
    this.maxMessages = 200;
    this.isOpen = false;
    this.unreadCount = 0;
    this._el = null;
    this._listEl = null;
    this._badgeEl = null;
    this._autoScroll = true;
  }

  create(container) {
    this._el = document.createElement('div');
    this._el.className = 'chat-sidebar';
    this._el.innerHTML = `
      <div class="chat-header">
        <span class="chat-title">Session Chat</span>
        <button class="chat-close" title="Close (Ctrl+Shift+C)">×</button>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-area">
        <input type="text" class="chat-input" placeholder="Send message to sessions..." />
      </div>
    `;
    container.appendChild(this._el);

    this._listEl = this._el.querySelector('#chat-messages');
    this._el.querySelector('.chat-close').addEventListener('click', () => this.toggle());

    // Auto-scroll detection
    this._listEl.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = this._listEl;
      this._autoScroll = scrollHeight - scrollTop - clientHeight < 50;
    });

    // Input handling
    const input = this._el.querySelector('.chat-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        this._onSendMessage(input.value.trim());
        input.value = '';
      }
    });
  }

  createToggleButton(container) {
    const btn = document.createElement('button');
    btn.className = 'chat-toggle-btn';
    btn.innerHTML = '💬';
    btn.title = 'Toggle Chat (Ctrl+Shift+C)';
    btn.addEventListener('click', () => this.toggle());
    container.appendChild(btn);

    this._badgeEl = document.createElement('span');
    this._badgeEl.className = 'chat-badge';
    this._badgeEl.style.display = 'none';
    btn.appendChild(this._badgeEl);

    return btn;
  }

  toggle() {
    this.isOpen = !this.isOpen;
    if (this._el) {
      this._el.classList.toggle('chat-sidebar-open', this.isOpen);
    }
    if (this.isOpen) {
      this.unreadCount = 0;
      this._updateBadge();
      // Focus input
      const input = this._el.querySelector('.chat-input');
      if (input) input.focus();
    }
    // Dispatch event for layout adjustment
    document.dispatchEvent(new CustomEvent('chat:toggled', { detail: { open: this.isOpen } }));
  }

  addMessage(from, message, priority) {
    const msg = {
      from,
      message,
      priority,
      timestamp: Date.now(),
    };
    this.messages.push(msg);
    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }

    if (!this.isOpen) {
      this.unreadCount++;
      this._updateBadge();
    }

    this._renderMessage(msg);
  }

  _renderMessage(msg) {
    if (!this._listEl) return;

    const el = document.createElement('div');
    el.className = `chat-msg ${msg.priority === 'urgent' ? 'chat-msg-urgent' : ''}`;

    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const escapedFrom = this._escape(msg.from || 'system');
    const content = this._formatMessage(msg.message);

    el.innerHTML = `
      <div class="chat-msg-header">
        <span class="chat-msg-from">${escapedFrom}</span>
        <span class="chat-msg-time">${time}</span>
      </div>
      <div class="chat-msg-body">${content}</div>
    `;

    this._listEl.appendChild(el);

    // Remove oldest if too many DOM nodes
    while (this._listEl.children.length > this.maxMessages) {
      this._listEl.removeChild(this._listEl.firstChild);
    }

    if (this._autoScroll) {
      this._listEl.scrollTop = this._listEl.scrollHeight;
    }
  }

  _formatMessage(text) {
    const escaped = this._escape(text);
    // Special formatting for tagged messages
    if (escaped.startsWith('[RESULT ')) {
      return `<div class="chat-result">${escaped}</div>`;
    }
    if (escaped.startsWith('[PROGRESS')) {
      const match = escaped.match(/\[PROGRESS(?: (\d+)%)?\] (.*)/);
      if (match) {
        const pct = match[1] || '0';
        return `<div class="chat-progress"><div class="chat-progress-bar" style="width:${pct}%"></div><span>${match[2]}</span></div>`;
      }
    }
    if (escaped.startsWith('[SNIPPET ')) {
      return `<div class="chat-snippet"><pre>${escaped}</pre></div>`;
    }
    if (escaped.startsWith('[WORKER_FAILED]')) {
      return `<div class="chat-error">${escaped}</div>`;
    }
    return escaped;
  }

  _updateBadge() {
    if (!this._badgeEl) return;
    if (this.unreadCount > 0) {
      this._badgeEl.textContent = this.unreadCount > 99 ? '99+' : this.unreadCount;
      this._badgeEl.style.display = '';
    } else {
      this._badgeEl.style.display = 'none';
    }
  }

  _escape(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Set by renderer
  _onSendMessage(text) {}
}

export { ChatPanel };
