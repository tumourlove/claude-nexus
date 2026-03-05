import '@xterm/xterm/css/xterm.css';
import { TabManager } from './tab-manager';
import { ProjectPicker } from './project-picker';
import { ChatPanel } from './chat-panel';
import { RecipeLoader } from './recipe-loader';
import { CostTracker } from './cost-tracker';

const container = document.getElementById('terminal-container');
const tabBar = document.getElementById('tab-bar');
const tabManager = new TabManager(container, tabBar);
const recipeLoader = new RecipeLoader();
const costTracker = new CostTracker();

// Chat panel
const chatPanel = new ChatPanel();
chatPanel.create(document.getElementById('chat-sidebar-container'));
chatPanel.createToggleButton(document.querySelector('#tab-bar') || document.body);

// Wire send handler
chatPanel._onSendMessage = (text) => {
  // Echo message in chat so user sees what they sent
  chatPanel.addMessage('You', text, 'normal');
  // Broadcast to MCP servers (sessions see it via read_messages)
  window.nexus.broadcastMessage(text);
  // Also write to active session's PTY so Claude receives it as terminal input
  const activeId = tabManager.activeTabId;
  if (activeId) {
    window.nexus.terminalWrite(activeId, text + '\n');
  }
};

// Listen for inter-session messages to show in chat
window.nexus.onChatMessage((data) => {
  chatPanel.addMessage(data.from, data.message, data.priority);
});

// Keyboard shortcut for chat panel
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'C') {
    e.preventDefault();
    chatPanel.toggle();
  }
});

// New tab button
document.querySelector('.tab-add').addEventListener('click', () => {
  tabManager.createTab('Session');
});

// Help dropdown
const helpBtn = document.getElementById('help-btn');
const helpDropdown = document.getElementById('help-dropdown');

function toggleHelp() {
  const open = helpDropdown.style.display === 'none';
  helpDropdown.style.display = open ? 'block' : 'none';
  helpBtn.classList.toggle('active', open);
}

helpBtn.addEventListener('click', toggleHelp);

// Close dropdown when clicking outside
document.addEventListener('mousedown', (e) => {
  if (helpDropdown.style.display !== 'none' && !helpDropdown.contains(e.target) && e.target !== helpBtn) {
    helpDropdown.style.display = 'none';
    helpBtn.classList.remove('active');
  }
});

// Doc links open in default browser
document.getElementById('help-docs-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.nexus.openExternal('https://github.com/tumourlove/claude-nexus');
});
document.getElementById('help-issues-link').addEventListener('click', (e) => {
  e.preventDefault();
  window.nexus.openExternal('https://github.com/tumourlove/claude-nexus/issues');
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 't') {
    e.preventDefault();
    tabManager.createTab('Session');
  }
  if (e.ctrlKey && e.key === 'w') {
    e.preventDefault();
    if (tabManager.activeTabId) tabManager.closeTab(tabManager.activeTabId);
  }
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    const ids = [...tabManager.tabs.keys()];
    const idx = ids.indexOf(tabManager.activeTabId);
    const next = e.shiftKey
      ? (idx - 1 + ids.length) % ids.length
      : (idx + 1) % ids.length;
    tabManager.activateTab(ids[next]);
  }
  // Ctrl+Shift+D toggle dashboard (Shift avoids Ctrl+D conflict with Claude Code EOF)
  if (e.ctrlKey && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    const existing = [...tabManager.tabs.entries()].find(([, t]) => t.type === 'dashboard');
    if (existing) {
      tabManager.activateTab(existing[0]);
    } else {
      tabManager.createTab('Dashboard', { type: 'dashboard' });
    }
  }
  // Ctrl+Shift+H toggle history (Shift avoids Ctrl+H conflict with terminal backspace)
  if (e.ctrlKey && e.shiftKey && e.key === 'H') {
    e.preventDefault();
    const existing = [...tabManager.tabs.entries()].find(([, t]) => t.type === 'history');
    if (existing) {
      tabManager.activateTab(existing[0]);
    } else {
      tabManager.createTab('History', { type: 'history' });
    }
  }
  // Ctrl+1-9 jump to tab
  if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    const ids = [...tabManager.tabs.keys()];
    const idx = parseInt(e.key) - 1;
    if (idx < ids.length) tabManager.activateTab(ids[idx]);
  }
  // Ctrl+Shift+F: terminal search
  if (e.ctrlKey && e.shiftKey && e.key === 'F') {
    e.preventDefault();
    tabManager.toggleSearch();
  }
  // Ctrl+Plus: zoom in font
  if (e.ctrlKey && !e.shiftKey && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    tabManager.zoomFont(2);
  }
  // Ctrl+Minus: zoom out font
  if (e.ctrlKey && !e.shiftKey && e.key === '-') {
    e.preventDefault();
    tabManager.zoomFont(-2);
  }
  // Ctrl+0: reset font zoom
  if (e.ctrlKey && !e.shiftKey && e.key === '0') {
    e.preventDefault();
    tabManager.resetFontZoom();
  }
  // F1 or ? toggle help (only if not typing in terminal)
  if (e.key === 'F1') {
    e.preventDefault();
    toggleHelp();
  }
  // Escape closes help
  if (e.key === 'Escape' && helpDropdown.style.display !== 'none') {
    helpDropdown.style.display = 'none';
    helpBtn.classList.remove('active');
  }
});

// Handle resize
const ro = new ResizeObserver(() => tabManager.handleResize());
ro.observe(container);

// Handle session exit
window.nexus.onSessionExited(({ id }) => {
  tabManager.updateTabStatus(id, 'exited');
});

// Handle session status updates
window.nexus.onSessionStatus(({ id, status }) => {
  tabManager.updateTabStatus(id, status);
  // Track task assignments for badge timing
  if (status === 'working') {
    const dash = tabManager.getDashboard();
    if (dash) dash.recordTaskStart(id);
  }
  // Ambient breathing effect on terminal pane
  _updateBreathingEffect(id, status);
  refreshDashboard();
});

function _updateBreathingEffect(id, status) {
  const tab = tabManager.tabs.get(id);
  if (!tab || !tab.termEl) return;
  const pane = tab.termEl;
  pane.classList.remove('breathing-active', 'breathing-error');
  if (status === 'working' || status === 'in_progress') {
    pane.classList.add('breathing-active');
  } else if (status === 'error' || status === 'failed') {
    pane.classList.add('breathing-error');
  }
}

// Handle MCP-initiated session spawns
window.nexus.onSpawnRequested(({ id, label, cwd, initialPrompt, template }) => {
  tabManager.createTab(label || 'Worker', { id, cwd, initialPrompt, template });
});

// Handle tab relabeling when a session is reused
window.nexus.onSessionRelabeled(({ id, label }) => {
  tabManager.updateTabLabel(id, label);
});

// Startup: check if a project dir was passed, otherwise show picker
async function startup() {
  const startupCwd = await window.nexus.getStartupCwd();
  if (startupCwd) {
    tabManager.createTab('Lead', { isLead: true, cwd: startupCwd });
    // Load recipes from project
    await recipeLoader.loadFromProject(startupCwd);
    tabManager.setRecipes(recipeLoader.getRecipes());
  } else {
    const pickerEl = document.getElementById('project-picker');
    pickerEl.style.display = 'block';
    new ProjectPicker(pickerEl, async (projectPath) => {
      tabManager.createTab('Lead', { isLead: true, cwd: projectPath });
      await recipeLoader.loadFromProject(projectPath);
      tabManager.setRecipes(recipeLoader.getRecipes());
    });
  }
}
startup();

// Toast notifications with pause-on-hover, close button, stacking, and history
const toastContainer = document.getElementById('toast-container');
const notificationHistory = [];
const MAX_NOTIFICATION_HISTORY = 20;

function _addToHistory(title, body, type) {
  notificationHistory.push({ title, body, type, timestamp: Date.now() });
  if (notificationHistory.length > MAX_NOTIFICATION_HISTORY) notificationHistory.shift();
  _updateHistoryBadge();
}

function _updateHistoryBadge() {
  const badge = document.getElementById('notif-history-badge');
  if (badge) {
    badge.textContent = notificationHistory.length;
    badge.style.display = notificationHistory.length > 0 ? 'inline' : 'none';
  }
}

function _createToast(title, body, type) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<div class="toast-header"><strong>${title}</strong><span class="toast-close">&times;</span></div><span>${body}</span>`;
  toastContainer.appendChild(toast);

  // Close button
  toast.querySelector('.toast-close').addEventListener('click', () => {
    _dismissToast(toast);
  });

  // Auto-dismiss with pause-on-hover
  let dismissTimer = null;
  let remaining = 5000;
  let startTime = Date.now();

  function startTimer() {
    startTime = Date.now();
    dismissTimer = setTimeout(() => _dismissToast(toast), remaining);
  }

  toast.addEventListener('mouseenter', () => {
    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
      remaining -= (Date.now() - startTime);
      if (remaining < 500) remaining = 500;
    }
  });

  toast.addEventListener('mouseleave', () => {
    startTimer();
  });

  requestAnimationFrame(() => toast.classList.add('show'));
  startTimer();

  _addToHistory(title, body, type);
}

function _dismissToast(toast) {
  toast.classList.remove('show');
  toast.addEventListener('transitionend', () => toast.remove());
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 500);
}

function showToast(body, type = 'info') {
  _createToast(type === 'success' ? 'Achievement' : 'Notice', body, type);
}

window.nexus.onToast(({ title, body, type }) => {
  _createToast(title, body, type);
});

// Notification history panel
function _initNotificationHistoryPanel() {
  const statusBar = document.getElementById('status-bar');
  if (!statusBar) return;
  const wrapper = document.createElement('span');
  wrapper.id = 'notif-history-wrapper';
  wrapper.innerHTML = `<span id="notif-history-btn" class="notif-history-btn" title="Notification history">&#128276;<span id="notif-history-badge" class="notif-history-badge" style="display:none">0</span></span>`;
  // Insert before update-status
  const updateStatus = document.getElementById('update-status');
  statusBar.insertBefore(wrapper, updateStatus);

  const btn = wrapper.querySelector('#notif-history-btn');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    _toggleNotificationHistory();
  });
}

function _toggleNotificationHistory() {
  let panel = document.getElementById('notif-history-panel');
  if (panel) {
    panel.remove();
    return;
  }
  panel = document.createElement('div');
  panel.id = 'notif-history-panel';
  panel.className = 'notif-history-panel';
  if (notificationHistory.length === 0) {
    panel.innerHTML = '<div class="notif-history-empty">No notifications yet</div>';
  } else {
    panel.innerHTML = [...notificationHistory].reverse().map(n => {
      const time = new Date(n.timestamp).toLocaleTimeString();
      return `<div class="notif-history-item notif-history-${n.type}"><span class="notif-history-time">${time}</span><strong>${n.title}</strong><span>${n.body}</span></div>`;
    }).join('');
  }
  document.body.appendChild(panel);
  // Close on outside click
  const closeHandler = (e) => {
    if (!panel.contains(e.target) && e.target.id !== 'notif-history-btn') {
      panel.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

_initNotificationHistoryPanel();

// --- Cost indicator in status bar ---
function _initCostIndicator() {
  const statusBar = document.getElementById('status-bar');
  if (!statusBar) return;
  const costEl = document.createElement('span');
  costEl.id = 'cost-indicator';
  costEl.className = 'cost-indicator';
  costEl.title = 'Estimated session cost';
  costEl.textContent = 'Cost: N/A';
  // Insert after session-count
  const sessionCount = document.getElementById('session-count');
  if (sessionCount && sessionCount.nextSibling) {
    statusBar.insertBefore(costEl, sessionCount.nextSibling);
  } else {
    statusBar.appendChild(costEl);
  }

  costTracker.onChange((agg) => {
    const costText = agg.totalCost > 0 ? `$${agg.totalCost.toFixed(2)}` : 'N/A';
    const burnText = agg.burnRate > 0.001 ? ` ($${agg.burnRate.toFixed(2)}/min)` : '';
    costEl.textContent = `Cost: ${costText}${burnText}`;
    costEl.title = `Input: ${agg.totalInputTokens.toLocaleString()} tokens | Output: ${agg.totalOutputTokens.toLocaleString()} tokens | ${agg.sessionCount} session(s)`;
    // Also update dashboard if open
    const dash = tabManager.getDashboard();
    if (dash) dash.updateCost(agg);
  });
}
_initCostIndicator();

// --- Dashboard event-driven updates ---

// Output previews -> dashboard cards + sparkline activity tracking + cost tracking
window.nexus.onOutputPreview(({ id, lines }) => {
  const dash = tabManager.getDashboard();
  if (dash) {
    dash.updatePreview(id, lines);
    dash.recordOutput(id);
    // Mood detection from latest output lines
    const text = lines.join(' ');
    if (text.trim()) dash.detectMood(id, text);
  }
  // Feed lines to cost tracker for token/cost parsing
  if (lines && lines.length > 0) {
    costTracker.parseOutput(id, lines.join('\n'));
  }
});

// Stuck warnings -> dashboard + notification
window.nexus.onStuckWarning(({ id, lastOutputAge }) => {
  const dash = tabManager.getDashboard();
  if (dash) dash.addLogEntry(`\u26a0 Session ${id} appears stuck (no output for ${lastOutputAge}s)`);
  tabManager.incrementBadge(id);
});

// Worker results -> dashboard results panel + badge on lead
window.nexus.onSessionResult(({ id, result, status, timestamp }) => {
  const dash = tabManager.getDashboard();
  if (dash) {
    const label = [...tabManager.tabs.values()].find(t => t.tabEl?.dataset?.tabId === id)?.label || id;
    dash.addResult({ id, label, result, status, timestamp });
    dash.addLogEntry(`Result from ${label}: ${status}`);
    // Track completion for badges and stats
    const completionResult = dash.recordCompletion(id, label, result?.length || 0);
    if (completionResult.badges.length > 0) {
      const latest = completionResult.badges[completionResult.badges.length - 1];
      showToast(`${label} earned ${latest}!`, 'success');
    }
  }
  // Badge the lead tab
  for (const [tid, t] of tabManager.tabs) {
    if (t.label === 'Lead') tabManager.incrementBadge(tid);
  }
});

// All workers done -> notification
window.nexus.onAllWorkersComplete(({ results }) => {
  const dash = tabManager.getDashboard();
  if (dash) dash.addLogEntry(`\u2713 All ${results.length} workers complete!`);
});

// Auto-retry notification
window.nexus.onRetryAvailable(({ id, retryCount, maxRetries }) => {
  const dash = tabManager.getDashboard();
  if (dash) {
    dash.addLogEntry(`\u2717 Session ${id} failed (retry ${retryCount}/${maxRetries} available)`);
  }
});

// Task queue updates -> dashboard task board
window.nexus.onTasksUpdated((data) => {
  const dash = tabManager.getDashboard();
  if (dash) dash.updateTasks(data.tasks);
});

// Session progress updates -> dashboard progress bars
window.nexus.onSessionProgress((data) => {
  const dash = tabManager.getDashboard();
  if (dash) dash.updateProgress(data);
});

// Heartbeat events — wire up listener (dashboard auto-refreshes on status changes)
window.nexus.onSessionHeartbeat(() => {});

// Focus tab from dashboard
window.addEventListener('nexus:focus-tab', (e) => {
  tabManager.activateTab(e.detail.id);
});

// Refresh dashboard with current sessions (trailing-edge debounce for latest state)
let _refreshTimer = null;
function refreshDashboard() {
  if (_refreshTimer) clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(async () => {
    _refreshTimer = null;
    const dash = tabManager.getDashboard();
    if (!dash) return;
    const sessions = await window.nexus.listSessions();
    dash.updateSessions(sessions);
  }, 200);
}

// Also refresh when sessions are created/exited
window.nexus.onSessionCreated(() => { refreshDashboard(); updateStatusBar(); });
window.nexus.onSessionExited(() => { refreshDashboard(); updateStatusBar(); });

// Update session count (event-driven, no polling)
function updateStatusBar() {
  const count = tabManager.tabs.size;
  document.getElementById('session-count').textContent = `${count} session${count !== 1 ? 's' : ''}`;
}
updateStatusBar();

// --- Auto-updater UI ---
const updateEl = document.getElementById('update-status');
const versionEl = document.getElementById('app-version');

window.nexus.getVersion().then(v => {
  versionEl.textContent = `v${v}`;
});

const checkBtn = document.getElementById('check-update-btn');
checkBtn.addEventListener('click', () => {
  checkBtn.textContent = 'Checking...';
  checkBtn.disabled = true;
  window.nexus.checkForUpdates();
  // Reset after timeout if no response
  setTimeout(() => {
    if (checkBtn.textContent === 'Checking...') {
      checkBtn.textContent = 'Check for updates';
      checkBtn.disabled = false;
    }
  }, 10000);
});

window.nexus.onUpdateAvailable(({ version }) => {
  checkBtn.style.display = 'none';
  updateEl.className = 'update-available';
  updateEl.textContent = `Update v${version} available`;
  updateEl.title = 'Click to download';
  updateEl.onclick = () => {
    updateEl.textContent = 'Downloading...';
    updateEl.onclick = null;
    window.nexus.downloadUpdate();
  };
});

window.nexus.onUpdateUpToDate(() => {
  updateEl.textContent = 'Up to date';
  checkBtn.textContent = 'Check for updates';
  checkBtn.disabled = false;
  setTimeout(() => { updateEl.textContent = ''; }, 3000);
});

window.nexus.onUpdateProgress(({ percent }) => {
  updateEl.textContent = `Downloading... ${percent}%`;
});

window.nexus.onUpdateReady(() => {
  updateEl.className = 'update-ready';
  updateEl.textContent = 'Update ready — click to restart';
  updateEl.title = 'Restart and install update';
  updateEl.onclick = () => window.nexus.installUpdate();
});

window.nexus.onUpdateError(() => {
  updateEl.textContent = '';
  checkBtn.textContent = 'Check for updates';
  checkBtn.disabled = false;
});
