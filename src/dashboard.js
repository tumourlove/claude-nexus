export class Dashboard {
  constructor(containerEl) {
    this.container = containerEl;
    this.container.className = 'dashboard';
    this.previews = new Map(); // id -> string[]
    this.results = [];
    this._render();
    this._bindEvents();
  }

  _render() {
    this.container.innerHTML = `
      <div class="dash-toolbar">
        <h2>Nexus Dashboard</h2>
        <div class="dash-toolbar-actions">
          <button class="dash-btn" id="dash-broadcast-btn" title="Broadcast message to all sessions">Broadcast</button>
          <button class="dash-btn" id="dash-update-claude-btn" title="Update Claude Code CLI">Update Claude</button>
          <button class="dash-btn" id="dash-update-nexus-btn" title="Check for Nexus updates">Update Nexus</button>
        </div>
      </div>
      <div class="dash-cards" id="dash-cards">
        <div class="dashboard-empty">No sessions yet</div>
      </div>
      <div class="dash-results-panel" id="dash-results" style="display:none">
        <h3>Worker Results</h3>
        <div class="dash-results-list" id="dash-results-list"></div>
      </div>
      <div class="dash-log-panel">
        <h3>Activity</h3>
        <div class="dashboard-log" id="dash-log">
          <div class="dashboard-empty">No activity yet</div>
        </div>
      </div>
    `;
  }

  _bindEvents() {
    this.container.querySelector('#dash-broadcast-btn').addEventListener('click', () => {
      const text = prompt('Broadcast message to all sessions:');
      if (text) window.nexus.broadcastMessage(text);
    });

    this.container.querySelector('#dash-update-claude-btn').addEventListener('click', async () => {
      const btn = this.container.querySelector('#dash-update-claude-btn');
      btn.textContent = 'Updating...';
      btn.disabled = true;
      const result = await window.nexus.updateClaude();
      btn.textContent = result.success ? 'Updated!' : 'Failed';
      setTimeout(() => { btn.textContent = 'Update Claude'; btn.disabled = false; }, 3000);
    });

    this.container.querySelector('#dash-update-nexus-btn').addEventListener('click', () => {
      window.nexus.checkForUpdates();
    });

    // Event delegation for card action buttons (bound once, survives DOM rebuilds)
    this.container.querySelector('#dash-cards').addEventListener('click', (e) => {
      const btn = e.target.closest('.dash-card-btn');
      if (!btn) return;
      this._handleCardAction(btn.dataset.action, btn.dataset.id);
    });
  }

  updateSessions(sessions) {
    const el = this.container.querySelector('#dash-cards');
    if (!sessions || sessions.length === 0) {
      el.innerHTML = '<div class="dashboard-empty">No sessions yet</div>';
      return;
    }
    el.innerHTML = sessions.map(s => {
      const preview = this.previews.get(s.id) || [];
      return `
        <div class="dash-card ${s.isLead ? 'dash-card-lead' : ''} dash-card-${s.status || 'idle'}" data-id="${s.id}">
          <div class="dash-card-header">
            <span class="health-pulse ${s.health || 'unknown'}"></span>
            <span class="dash-card-status status-${s.status || 'idle'}"></span>
            <span class="dash-card-label">${s.label || s.id}</span>
            <span class="dash-card-template">${s.template || ''}</span>
            ${s.isLead ? '<span class="dash-card-lead-badge">LEAD</span>' : ''}
            ${s.retryCount ? `<span class="retry-badge">retry ${s.retryCount}/${s.maxRetries}</span>` : ''}
            <span class="dash-card-cwd" title="${s.cwd || ''}">${this._shortenPath(s.cwd)}</span>
          </div>
          <div class="dash-card-preview">${preview.length ? preview.map(l => `<div class="dash-preview-line">${this._escapeHtml(l)}</div>`).join('') : '<span class="dash-preview-empty">No output yet</span>'}</div>
          <div class="dash-card-actions">
            <button class="dash-card-btn dash-focus-btn" data-action="focus" data-id="${s.id}" title="Focus this tab">Focus</button>
            <button class="dash-card-btn dash-msg-btn" data-action="message" data-id="${s.id}" title="Send message">Message</button>
            <button class="dash-card-btn dash-restart-btn" data-action="restart" data-id="${s.id}" title="Restart session">Restart</button>
            <button class="dash-card-btn dash-cancel-btn" data-action="cancel" data-id="${s.id}" title="Send SIGINT">Cancel</button>
          </div>
        </div>
      `;
    }).join('');
  }

  _handleCardAction(action, id) {
    switch (action) {
      case 'focus':
        // Dispatch custom event for renderer to handle
        window.dispatchEvent(new CustomEvent('nexus:focus-tab', { detail: { id } }));
        break;
      case 'message': {
        const text = prompt(`Message to ${id}:`);
        if (text) window.nexus.sendQuickMessage(id, text);
        break;
      }
      case 'restart':
        if (confirm(`Restart session ${id}?`)) window.nexus.restartSession(id);
        break;
      case 'cancel':
        window.nexus.cancelSession(id);
        break;
    }
  }

  updatePreview(id, lines) {
    this.previews.set(id, lines);
    // Update just the preview area if card exists
    const card = this.container.querySelector(`.dash-card[data-id="${id}"] .dash-card-preview`);
    if (card) {
      card.innerHTML = lines.map(l => `<div class="dash-preview-line">${this._escapeHtml(l)}</div>`).join('');
    }
  }

  addResult(result) {
    this.results.push(result);
    if (this.results.length > 200) this.results.shift();
    const panel = this.container.querySelector('#dash-results');
    panel.style.display = 'block';
    const list = this.container.querySelector('#dash-results-list');
    const entry = document.createElement('div');
    entry.className = `dash-result-entry dash-result-${result.status}`;
    const time = new Date(result.timestamp).toLocaleTimeString();
    entry.innerHTML = `
      <span class="dash-result-status">${result.status === 'success' ? '\u2713' : '\u2717'}</span>
      <span class="dash-result-label">${result.label || result.id}</span>
      <span class="dash-result-text">${this._escapeHtml(result.result)}</span>
      <span class="dash-result-time">${time}</span>
    `;
    list.appendChild(entry);
    while (list.children.length > 200) list.removeChild(list.firstChild);
  }

  addLogEntry(message) {
    const el = this.container.querySelector('#dash-log');
    if (!el) return;
    const empty = el.querySelector('.dashboard-empty');
    if (empty) empty.remove();
    const entry = document.createElement('div');
    entry.className = 'dash-log-entry';
    const time = new Date().toLocaleTimeString();
    entry.innerHTML = `<span class="dash-log-time">${time}</span> ${this._escapeHtml(message)}`;
    el.appendChild(entry);
    while (el.children.length > 100) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

  _escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  _shortenPath(p) {
    if (!p) return '';
    const parts = p.replace(/\\/g, '/').split('/');
    return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : p;
  }

  dispose() {
    this.previews.clear();
    this.results.length = 0;
    this.container.innerHTML = '';
  }
}
