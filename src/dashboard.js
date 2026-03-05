export class Dashboard {
  constructor(containerEl) {
    this.container = containerEl;
    this.container.className = 'dashboard';
    this.previews = new Map(); // id -> string[]
    this.results = [];
    this._stats = {
      tasksCompleted: 0,
      totalTime: 0,
      fastestWorker: null,
      fastestTime: Infinity,
    };
    this._badges = new Map(); // sessionId -> Set of badge names
    this._taskStartTimes = new Map(); // sessionId -> timestamp
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
      <div class="dash-stats" id="dash-stats">
        <span class="stat-item">Tasks: <strong id="stat-tasks">0</strong></span>
        <span class="stat-item">Fastest: <strong id="stat-fastest">—</strong></span>
        <span class="stat-item">Workers: <strong id="stat-workers">0</strong></span>
      </div>
      <div class="dash-cards" id="dash-cards">
        <div class="dashboard-empty">No sessions yet</div>
      </div>
      <div class="dash-results-panel" id="dash-results" style="display:none">
        <h3>Worker Results</h3>
        <div class="dash-results-list" id="dash-results-list"></div>
      </div>
      <div class="dash-section" id="dash-tasks">
        <h3>Task Queue</h3>
        <div id="dash-task-list" class="dash-task-list"></div>
      </div>
      <div class="dash-section" id="dash-task-graph-section">
        <h3>Task Graph</h3>
        <div id="dash-task-graph"></div>
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
          ${this.getBadges(s.id).length ? `<div class="session-badges">${this.getBadges(s.id).map(b => `<span class="badge">${b}</span>`).join('')}</div>` : ''}
          <div class="dash-card-preview">${preview.length ? preview.map(l => `<div class="dash-preview-line">${this._escapeHtml(l)}</div>`).join('') : '<span class="dash-preview-empty">No output yet</span>'}</div>
          ${s.progress || (this._progress && this._progress[s.id]) ? `<div class="progress-bar"><div class="progress-fill" style="width:${(s.progress || this._progress[s.id]).percent || 0}%"></div><span class="progress-text">${this._escape((s.progress || this._progress[s.id]).message)}</span></div>` : ''}
          <div class="dash-card-actions">
            <button class="dash-card-btn dash-focus-btn" data-action="focus" data-id="${s.id}" title="Focus this tab">Focus</button>
            <button class="dash-card-btn dash-msg-btn" data-action="message" data-id="${s.id}" title="Send message">Message</button>
            <button class="dash-card-btn dash-restart-btn" data-action="restart" data-id="${s.id}" title="Restart session">Restart</button>
            <button class="dash-card-btn dash-cancel-btn" data-action="cancel" data-id="${s.id}" title="Send SIGINT">Cancel</button>
          </div>
        </div>
      `;
    }).join('');
    this.updateStats(sessions);
  }

  updateStats(sessions) {
    const workers = sessions.filter(s => !s.isLead);
    const activeWorkers = workers.filter(s => s.status === 'working' || s.status === 'in_progress');

    const tasksEl = document.getElementById('stat-tasks');
    const fastestEl = document.getElementById('stat-fastest');
    const workersEl = document.getElementById('stat-workers');

    if (tasksEl) tasksEl.textContent = this._stats.tasksCompleted;
    if (fastestEl) fastestEl.textContent = this._stats.fastestWorker
      ? `${this._stats.fastestWorker} (${Math.round(this._stats.fastestTime / 1000)}s)`
      : '\u2014';
    if (workersEl) workersEl.textContent = `${activeWorkers.length}/${workers.length}`;
  }

  recordCompletion(sessionId, label, resultLength) {
    const startTime = this._taskStartTimes.get(sessionId);
    const duration = startTime ? Date.now() - startTime : null;
    this._taskStartTimes.delete(sessionId);

    this._stats.tasksCompleted++;
    if (duration && duration < this._stats.fastestTime) {
      this._stats.fastestTime = duration;
      this._stats.fastestWorker = label || sessionId;
    }

    // Check badges
    if (!this._badges.has(sessionId)) this._badges.set(sessionId, new Set());
    const badges = this._badges.get(sessionId);

    if (duration && duration < 30000) badges.add('\u26a1 Speed Demon');
    if (resultLength && resultLength > 1000) badges.add('\ud83d\udcdd Thorough');

    // Count completions for Reliable badge
    let completions = 0;
    for (const [, b] of this._badges) {
      if (b.has('\u26a1 Speed Demon') || b.has('\ud83d\udcdd Thorough')) completions++;
    }

    return { badges: [...badges], duration };
  }

  recordTaskStart(sessionId) {
    this._taskStartTimes.set(sessionId, Date.now());
  }

  getBadges(sessionId) {
    return [...(this._badges.get(sessionId) || [])];
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

  updateTasks(tasks) {
    const el = document.getElementById('dash-task-list');
    if (!el) return;
    if (!tasks || tasks.length === 0) {
      el.innerHTML = '<div class="dash-empty">No tasks in queue</div>';
      this.renderGraph(tasks);
      return;
    }
    const statusOrder = ['in_progress', 'assigned', 'pending', 'done', 'failed'];
    const sorted = [...tasks].sort((a, b) => {
      const ai = statusOrder.indexOf(a.status);
      const bi = statusOrder.indexOf(b.status);
      return ai - bi || a.priority - b.priority;
    });
    el.innerHTML = sorted.map(t => `
      <div class="dash-task dash-task-${t.status}">
        <span class="task-priority">P${t.priority}</span>
        <span class="task-title">${this._escape(t.title)}</span>
        <span class="task-status">${t.status}</span>
        ${t.assignee ? `<span class="task-assignee">${this._escape(t.assignee)}</span>` : ''}
      </div>
    `).join('');
    this.renderGraph(tasks);
  }

  renderGraph(tasks) {
    const container = document.getElementById('dash-task-graph');
    if (!container) return;
    if (!tasks || tasks.length === 0) {
      container.innerHTML = '<div class="dash-empty">No tasks to visualize</div>';
      return;
    }

    // Build adjacency info
    const taskMap = new Map(tasks.map(t => [t.id, t]));

    // Topological layers
    const layers = [];
    const placed = new Set();
    let remaining = [...tasks];

    while (remaining.length > 0) {
      const layer = remaining.filter(t =>
        (t.dependencies || []).every(d => placed.has(d))
      );
      if (layer.length === 0) {
        // Circular deps — just dump remaining
        layers.push(remaining);
        break;
      }
      layers.push(layer);
      layer.forEach(t => placed.add(t.id));
      remaining = remaining.filter(t => !placed.has(t.id));
    }

    // Render
    const statusColors = {
      pending: '#6b7280',
      assigned: '#8b5cf6',
      in_progress: '#3b82f6',
      done: '#4ade80',
      failed: '#ef4444',
    };

    let html = '<div class="task-graph">';
    layers.forEach((layer, layerIdx) => {
      html += `<div class="graph-layer">`;
      layer.forEach(t => {
        const color = statusColors[t.status] || '#6b7280';
        const blocked = (t.dependencies || []).some(d => {
          const dep = taskMap.get(d);
          return dep && dep.status !== 'done';
        });
        html += `
          <div class="graph-node ${blocked ? 'graph-node-blocked' : ''}" style="border-color:${color}" title="${this._escape(t.title)}\nStatus: ${t.status}\nPriority: ${t.priority}${t.assignee ? '\nAssigned: ' + t.assignee : ''}">
            <div class="graph-node-id" style="background:${color}">#${t.id}</div>
            <div class="graph-node-title">${this._escape(t.title.slice(0, 30))}</div>
            ${t.assignee ? `<div class="graph-node-assignee">${this._escape(t.assignee)}</div>` : ''}
          </div>`;
      });
      html += `</div>`;
      if (layerIdx < layers.length - 1) {
        html += `<div class="graph-arrow">\u2192</div>`;
      }
    });
    html += '</div>';
    container.innerHTML = html;
  }

  updateProgress(data) {
    if (!this._progress) this._progress = {};
    this._progress[data.id] = { message: data.message, percent: data.percent };
  }

  _escape(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
