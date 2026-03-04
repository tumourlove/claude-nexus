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
  // Ctrl+H toggle history
  if (e.ctrlKey && e.key === 'h') {
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

// --- Auto-updater UI ---
const updateEl = document.getElementById('update-status');
const versionEl = document.getElementById('app-version');

window.nexus.getVersion().then(v => {
  versionEl.textContent = `v${v}`;
});

window.nexus.onUpdateAvailable(({ version }) => {
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
  updateEl.textContent = '';
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
});
