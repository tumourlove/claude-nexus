import '@xterm/xterm/css/xterm.css';
import { TabManager } from './tab-manager';
import { ProjectPicker } from './project-picker';

const container = document.getElementById('terminal-container');
const tabBar = document.getElementById('tab-bar');
const tabManager = new TabManager(container, tabBar);

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
  refreshDashboard();
});

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
  } else {
    const pickerEl = document.getElementById('project-picker');
    pickerEl.style.display = 'block';
    new ProjectPicker(pickerEl, (projectPath) => {
      tabManager.createTab('Lead', { isLead: true, cwd: projectPath });
    });
  }
}
startup();

// Toast notifications
const toastContainer = document.getElementById('toast-container');
window.nexus.onToast(({ title, body, type }) => {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<strong>${title}</strong><span>${body}</span>`;
  toastContainer.appendChild(toast);
  // Trigger animation
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    toast.addEventListener('transitionend', () => toast.remove());
    // Fallback removal if transition doesn't fire
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 500);
  }, 4000);
});

// --- Dashboard event-driven updates ---

// Output previews -> dashboard cards
window.nexus.onOutputPreview(({ id, lines }) => {
  const dash = tabManager.getDashboard();
  if (dash) dash.updatePreview(id, lines);
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
