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
  // Ctrl+D toggle dashboard
  if (e.ctrlKey && e.key === 'd') {
    e.preventDefault();
    const existing = [...tabManager.tabs.entries()].find(([, t]) => t.type === 'dashboard');
    if (existing) {
      tabManager.activateTab(existing[0]);
    } else {
      tabManager.createTab('Dashboard', { type: 'dashboard' });
    }
  }
  // Ctrl+1-9 jump to tab
  if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    const ids = [...tabManager.tabs.keys()];
    const idx = parseInt(e.key) - 1;
    if (idx < ids.length) tabManager.activateTab(ids[idx]);
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
});

// Handle MCP-initiated session spawns
window.nexus.onSpawnRequested(({ id, label, cwd, initialPrompt, template }) => {
  tabManager.createTab(label || 'Worker', { id, cwd, initialPrompt, template });
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
  }, 4000);
});

// Update session count
function updateStatusBar() {
  const count = tabManager.tabs.size;
  document.getElementById('session-count').textContent = `${count} session${count !== 1 ? 's' : ''}`;
}
setInterval(updateStatusBar, 1000);
