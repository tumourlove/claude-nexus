import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Dashboard } from './dashboard';
import { HistoryPanel } from './history-panel';

export class TabManager {
  constructor(containerEl, tabBarEl) {
    this.container = containerEl;
    this.tabBar = tabBarEl;
    this.tabs = new Map(); // id -> { term?, fitAddon?, termEl, tabEl, label, type, dashboard? }
    this.activeTabId = null;
    this.nextId = 1;
    this.unreadCounts = new Map(); // id -> number
  }

  createTab(label = 'Session', options = {}) {
    const id = options.id || `tab-${this.nextId++}`;
    const type = options.type || 'terminal';

    // Pane element
    const termEl = document.createElement('div');
    termEl.className = type === 'dashboard' ? 'dashboard-pane' : 'terminal-pane';
    termEl.style.display = 'none';
    this.container.appendChild(termEl);

    // Tab bar button
    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.dataset.tabId = id;
    tabEl.innerHTML = `
      <span class="tab-status${type === 'dashboard' ? ' status-dashboard' : ''}"></span>
      <span class="tab-label">${label}</span>
      <span class="tab-close">&times;</span>
    `;
    tabEl.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) {
        this.closeTab(id);
      } else {
        this.activateTab(id);
      }
    });

    const addBtn = this.tabBar.querySelector('.tab-add');
    this.tabBar.insertBefore(tabEl, addBtn);

    if (type === 'dashboard') {
      const dashboard = new Dashboard(termEl);
      this.tabs.set(id, { termEl, tabEl, label, type, dashboard });
      this.activateTab(id);
      return id;
    }

    if (type === 'history') {
      const historyPanel = new HistoryPanel(termEl);
      this.tabs.set(id, { termEl, tabEl, label, type, historyPanel });
      this.activateTab(id);
      return id;
    }

    // Terminal tab
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#e94560',
        selectionBackground: '#e9456040',
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termEl);

    // Custom key handling: clipboard, newlines, QoL
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      // Ctrl+C: copy if selection exists, otherwise send SIGINT
      if (e.ctrlKey && !e.shiftKey && e.key === 'c') {
        const sel = term.getSelection();
        if (sel) {
          window.nexus.clipboardWriteText(sel);
          term.clearSelection();
          return false;
        }
        return true; // no selection → SIGINT
      }

      // Ctrl+V: paste text or image
      if (e.ctrlKey && e.key === 'v') {
        (async () => {
          if (window.nexus.clipboardHasImage()) {
            const imgPath = await window.nexus.saveClipboardImage();
            if (imgPath) {
              window.nexus.terminalWrite(id, imgPath);
              return;
            }
          }
          const text = window.nexus.clipboardReadText();
          if (text) window.nexus.terminalWrite(id, text);
        })();
        return false;
      }

      // Ctrl+X: copy selection and clear
      if (e.ctrlKey && e.key === 'x') {
        const sel = term.getSelection();
        if (sel) {
          window.nexus.clipboardWriteText(sel);
          term.clearSelection();
        }
        return false;
      }

      // Ctrl+A: select all terminal content
      if (e.ctrlKey && e.key === 'a') {
        term.selectAll();
        return false;
      }

      // Ctrl+L: clear terminal scrollback
      if (e.ctrlKey && e.key === 'l') {
        term.clear();
        return false;
      }

      // Shift+Enter: send newline to Claude Code (for multi-line input)
      if (e.shiftKey && e.key === 'Enter') {
        window.nexus.terminalWrite(id, '\n');
        return false;
      }

      return true;
    });

    term.onData((data) => window.nexus.terminalWrite(id, data));
    window.nexus.onTerminalData(id, (data) => term.write(data));

    this.tabs.set(id, { term, fitAddon, termEl, tabEl, label, type });
    this.activateTab(id);

    // Defer session creation so the terminal has settled dimensions.
    // Without this, the pty spawns at 80x30 and Claude Code renders its
    // initial UI before the resize message arrives, causing layout glitches.
    requestAnimationFrame(() => {
      fitAddon.fit();
      const cols = term.cols;
      const rows = term.rows;
      window.nexus.createSession(id, label, {
        cwd: options.cwd,
        initialPrompt: options.initialPrompt,
        template: options.template,
        isLead: options.isLead,
        cols,
        rows,
      });
    });

    return id;
  }

  activateTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    for (const [tid, t] of this.tabs) {
      t.termEl.style.display = tid === id ? 'block' : 'none';
      t.tabEl.classList.toggle('active', tid === id);
    }

    this.activeTabId = id;
    this.clearBadge(id);

    if (tab.type === 'terminal' && tab.fitAddon) {
      tab.fitAddon.fit();
      tab.term.focus();
      window.nexus.resizeTerminal(id, tab.term.cols, tab.term.rows);
    }
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    if (tab.type === 'dashboard' && tab.dashboard) {
      tab.dashboard.dispose();
    } else if (tab.type === 'history' && tab.historyPanel) {
      tab.historyPanel.dispose();
    } else if (tab.term) {
      tab.term.dispose();
    }
    tab.termEl.remove();
    tab.tabEl.remove();
    this.tabs.delete(id);

    if (tab.type === 'terminal') {
      window.nexus.closeSession(id);
    }

    if (this.activeTabId === id) {
      const remaining = [...this.tabs.keys()];
      if (remaining.length > 0) {
        this.activateTab(remaining[remaining.length - 1]);
      }
    }
  }

  handleResize() {
    if (this.activeTabId) {
      const tab = this.tabs.get(this.activeTabId);
      if (tab && tab.type === 'terminal' && tab.fitAddon) {
        tab.fitAddon.fit();
        window.nexus.resizeTerminal(this.activeTabId, tab.term.cols, tab.term.rows);
      }
    }
  }

  updateTabStatus(id, status) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const statusEl = tab.tabEl.querySelector('.tab-status');
    statusEl.className = `tab-status status-${status}`;
  }

  updateTabLabel(id, label) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.label = label;
    tab.tabEl.querySelector('.tab-label').textContent = label;
  }

  incrementBadge(id) {
    if (id === this.activeTabId) return; // don't badge active tab
    const count = (this.unreadCounts.get(id) || 0) + 1;
    this.unreadCounts.set(id, count);
    this._renderBadge(id);
  }

  clearBadge(id) {
    this.unreadCounts.delete(id);
    this._renderBadge(id);
  }

  _renderBadge(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const labelEl = tab.tabEl.querySelector('.tab-label');
    // Remove existing badge
    const existing = tab.tabEl.querySelector('.tab-badge');
    if (existing) existing.remove();

    const count = this.unreadCounts.get(id) || 0;
    if (count > 0) {
      const badge = document.createElement('span');
      badge.className = 'tab-badge';
      badge.textContent = count > 9 ? '9+' : count;
      labelEl.after(badge);
    }
  }

  getDashboard() {
    for (const [, tab] of this.tabs) {
      if (tab.type === 'dashboard') return tab.dashboard;
    }
    return null;
  }
}
