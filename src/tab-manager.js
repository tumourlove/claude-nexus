import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Dashboard } from './dashboard';
import { HistoryPanel } from './history-panel';

const DEFAULT_FONT_SIZE = 14;

export class TabManager {
  constructor(containerEl, tabBarEl) {
    this.container = containerEl;
    this.tabBar = tabBarEl;
    this.tabs = new Map(); // id -> { term?, fitAddon?, termEl, tabEl, label, type, dashboard? }
    this.activeTabId = null;
    this.nextId = 1;
    this.unreadCounts = new Map(); // id -> number
    this.closedTabs = []; // stack of recently closed tabs (max 10)
    this._contextMenu = null;
    this._setupContextMenuDismiss();
  }

  // --- Feature 3: Session color from ID hash ---
  _hashSessionColor(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = ((hash << 5) - hash) + id.charCodeAt(i);
      hash |= 0;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 65%, 55%)`;
  }

  createTab(label = 'Session', options = {}) {
    const id = options.id || `tab-${this.nextId++}`;
    const type = options.type || 'terminal';

    // Pane element
    const termEl = document.createElement('div');
    termEl.className = type === 'dashboard' ? 'dashboard-pane' : 'terminal-pane';
    termEl.setAttribute('role', 'tabpanel');
    termEl.setAttribute('aria-label', `${label} panel`);
    termEl.style.display = 'none';
    this.container.appendChild(termEl);

    // Tab bar button
    const sessionColor = this._hashSessionColor(id);
    const tabEl = document.createElement('div');
    tabEl.className = 'tab tab-enter';
    tabEl.dataset.tabId = id;
    tabEl.setAttribute('role', 'tab');
    tabEl.setAttribute('aria-selected', 'false');
    tabEl.setAttribute('aria-label', `${label} — idle`);
    tabEl.setAttribute('tabindex', '-1');
    tabEl.style.setProperty('--session-color', sessionColor);
    tabEl.style.borderLeft = `3px solid ${sessionColor}`;
    tabEl.innerHTML = `
      <span class="tab-color-dot" style="background:${sessionColor}"></span>
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
    // Double-click to rename
    tabEl.addEventListener('dblclick', (e) => {
      if (e.target.classList.contains('tab-close')) return;
      this._renameTab(id);
    });
    // Middle-click to close
    tabEl.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.closeTab(id);
      }
    });
    // Context menu on right-click
    tabEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._showContextMenu(e, id);
    });
    // Drag-to-reorder
    tabEl.draggable = true;
    tabEl.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', id);
      tabEl.classList.add('tab-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    tabEl.addEventListener('dragend', () => {
      tabEl.classList.remove('tab-dragging');
      this.tabBar.querySelectorAll('.tab-drop-target').forEach(el => el.classList.remove('tab-drop-target'));
    });
    tabEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tabEl.classList.add('tab-drop-target');
    });
    tabEl.addEventListener('dragleave', () => {
      tabEl.classList.remove('tab-drop-target');
    });
    tabEl.addEventListener('drop', (e) => {
      e.preventDefault();
      tabEl.classList.remove('tab-drop-target');
      const draggedId = e.dataTransfer.getData('text/plain');
      if (draggedId === id) return;
      this._reorderTab(draggedId, id);
    });
    // Remove entrance animation class after it plays
    tabEl.addEventListener('animationend', () => {
      tabEl.classList.remove('tab-enter');
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
      theme: this._terminalTheme || {
        background: '#1a1510',
        foreground: '#e8dcc8',
        cursor: '#c17f3e',
        selectionBackground: '#c17f3e40',
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termEl);

    // Scroll-to-bottom floating button
    const scrollBtn = document.createElement('button');
    scrollBtn.className = 'scroll-to-bottom';
    scrollBtn.innerHTML = '&#8595;'; // down arrow
    scrollBtn.title = 'Scroll to bottom';
    scrollBtn.style.display = 'none';
    termEl.appendChild(scrollBtn);

    scrollBtn.addEventListener('click', () => {
      term.scrollToBottom();
      scrollBtn.style.display = 'none';
    });

    // Show/hide based on scroll position
    term.onScroll(() => {
      const buffer = term.buffer.active;
      const isAtBottom = buffer.viewportY >= buffer.baseY;
      scrollBtn.style.display = isAtBottom ? 'none' : 'flex';
    });

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
      const isActive = tid === id;
      t.termEl.style.display = isActive ? 'block' : 'none';
      t.tabEl.classList.toggle('active', isActive);
      t.tabEl.setAttribute('aria-selected', String(isActive));
      t.tabEl.setAttribute('tabindex', isActive ? '0' : '-1');
    }

    this.activeTabId = id;
    this.clearBadge(id);

    if (tab.type === 'terminal' && tab.fitAddon) {
      tab.fitAddon.fit();
      tab.term.focus();
      window.nexus.resizeTerminal(id, tab.term.cols, tab.term.rows);
    }

    if (this.onTabActivated) this.onTabActivated(id);
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    // Hide search bar if open
    if (tab.type === 'terminal') this._hideSearchBar(id);

    // Save for reopen (terminal tabs only)
    if (tab.type === 'terminal') {
      this.closedTabs.push({ label: tab.label, type: tab.type });
      if (this.closedTabs.length > 10) this.closedTabs.shift();
    }

    // Animate tab exit then remove
    tab.tabEl.classList.add('tab-exit');
    tab.tabEl.addEventListener('animationend', () => {
      if (tab.type === 'dashboard' && tab.dashboard) {
        tab.dashboard.dispose();
      } else if (tab.type === 'history' && tab.historyPanel) {
        tab.historyPanel.dispose();
      } else if (tab.term) {
        tab.term.dispose();
      }
      tab.termEl.remove();
      tab.tabEl.remove();
    }, { once: true });

    this.tabs.delete(id);

    if (tab.type === 'terminal') {
      window.nexus.offTerminalData(id);
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
    tab.tabEl.setAttribute('aria-label', `${tab.label} — ${status}`);
    // Golden shimmer when a tab completes
    if (status === 'done') {
      tab.tabEl.classList.add('tab-done-shimmer');
      tab.tabEl.addEventListener('animationend', () => {
        tab.tabEl.classList.remove('tab-done-shimmer');
      }, { once: true });
    }
  }

  updateTabLabel(id, label) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.label = label;
    tab.tabEl.querySelector('.tab-label').textContent = label;
    const status = tab.tabEl.querySelector('.tab-status')?.className.replace('tab-status status-', '') || 'idle';
    tab.tabEl.setAttribute('aria-label', `${label} — ${status}`);
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

  // --- Feature 1: Terminal Search ---
  toggleSearch() {
    const id = this.activeTabId;
    const tab = this.tabs.get(id);
    if (!tab || tab.type !== 'terminal') return;

    const existing = tab.termEl.querySelector('.term-search-bar');
    if (existing) {
      this._hideSearchBar(id);
    } else {
      this._showSearchBar(id);
    }
  }

  _showSearchBar(id) {
    const tab = this.tabs.get(id);
    if (!tab || !tab.term) return;

    const bar = document.createElement('div');
    bar.className = 'term-search-bar';
    bar.innerHTML = `
      <input type="text" class="term-search-input" placeholder="Search terminal..." spellcheck="false" />
      <span class="term-search-count"></span>
      <button class="term-search-prev" title="Previous (Shift+Enter)">&#9650;</button>
      <button class="term-search-next" title="Next (Enter)">&#9660;</button>
      <button class="term-search-close" title="Close (Escape)">&times;</button>
    `;
    tab.termEl.appendChild(bar);

    const input = bar.querySelector('.term-search-input');
    const countEl = bar.querySelector('.term-search-count');
    let matches = [];
    let matchIdx = -1;

    const doSearch = (query) => {
      matches = [];
      matchIdx = -1;
      tab.term.clearSelection();
      if (!query) { countEl.textContent = ''; return; }

      const buffer = tab.term.buffer.active;
      const lowerQuery = query.toLowerCase();
      for (let row = 0; row < buffer.length; row++) {
        const line = buffer.getLine(row);
        if (!line) continue;
        const text = line.translateToString(true).toLowerCase();
        let col = 0;
        while ((col = text.indexOf(lowerQuery, col)) !== -1) {
          matches.push({ row, col, len: query.length });
          col += query.length;
        }
      }
      countEl.textContent = matches.length > 0 ? `${matches.length} found` : 'No results';
      if (matches.length > 0) navigateMatch(0);
    };

    const navigateMatch = (idx) => {
      if (matches.length === 0) return;
      matchIdx = ((idx % matches.length) + matches.length) % matches.length;
      const m = matches[matchIdx];
      tab.term.select(m.col, m.row, m.len);
      tab.term.scrollToLine(m.row);
      countEl.textContent = `${matchIdx + 1}/${matches.length}`;
    };

    input.addEventListener('input', () => doSearch(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) navigateMatch(matchIdx - 1);
        else navigateMatch(matchIdx + 1);
      }
      if (e.key === 'Escape') {
        this._hideSearchBar(id);
        tab.term.focus();
      }
    });
    bar.querySelector('.term-search-next').addEventListener('click', () => navigateMatch(matchIdx + 1));
    bar.querySelector('.term-search-prev').addEventListener('click', () => navigateMatch(matchIdx - 1));
    bar.querySelector('.term-search-close').addEventListener('click', () => {
      this._hideSearchBar(id);
      tab.term.focus();
    });

    requestAnimationFrame(() => input.focus());
  }

  _hideSearchBar(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const bar = tab.termEl.querySelector('.term-search-bar');
    if (bar) {
      tab.term?.clearSelection();
      bar.remove();
    }
  }

  // --- Tab Drag Reorder ---
  _reorderTab(draggedId, targetId) {
    const draggedTab = this.tabs.get(draggedId);
    const targetTab = this.tabs.get(targetId);
    if (!draggedTab || !targetTab) return;

    // Move DOM element
    this.tabBar.insertBefore(draggedTab.tabEl, targetTab.tabEl);

    // Rebuild Map to match new visual order
    const entries = [];
    const tabEls = this.tabBar.querySelectorAll('.tab[data-tab-id]');
    for (const el of tabEls) {
      const tid = el.dataset.tabId;
      if (this.tabs.has(tid)) entries.push([tid, this.tabs.get(tid)]);
    }
    this.tabs = new Map(entries);
  }

  // --- Feature 2: Tab Context Menu ---
  _setupContextMenuDismiss() {
    document.addEventListener('mousedown', (e) => {
      if (this._contextMenu && !this._contextMenu.contains(e.target)) {
        this._dismissContextMenu();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._dismissContextMenu();
    });
  }

  _showContextMenu(e, tabId) {
    this._dismissContextMenu();
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    const menu = document.createElement('div');
    menu.className = 'tab-context-menu';

    const items = [
      { label: 'Rename Tab', action: () => this._renameTab(tabId) },
      { label: 'Duplicate Tab', action: () => this._duplicateTab(tabId) },
      { label: 'Copy Session ID', action: () => { navigator.clipboard.writeText(tabId); } },
      { divider: true },
      { label: 'Spawn from Recipe...', action: () => this._spawnFromRecipe() },
      { divider: true },
      { label: 'Close Other Tabs', action: () => this._closeOtherTabs(tabId) },
      { label: 'Close Tab', action: () => this.closeTab(tabId) },
    ];

    for (const item of items) {
      if (item.divider) {
        const div = document.createElement('div');
        div.className = 'ctx-divider';
        menu.appendChild(div);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'ctx-item';
      el.textContent = item.label;
      el.addEventListener('click', () => {
        this._dismissContextMenu();
        item.action();
      });
      menu.appendChild(el);
    }

    // Position at cursor, clamp to viewport
    menu.style.left = `${Math.min(e.clientX, window.innerWidth - 180)}px`;
    menu.style.top = `${Math.min(e.clientY, window.innerHeight - 200)}px`;
    document.body.appendChild(menu);
    this._contextMenu = menu;
  }

  _dismissContextMenu() {
    if (this._contextMenu) {
      this._contextMenu.remove();
      this._contextMenu = null;
    }
  }

  _renameTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const name = prompt('Rename tab:', tab.label);
    if (name && name.trim()) {
      this.updateTabLabel(id, name.trim());
    }
  }

  _duplicateTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.createTab(tab.label + ' (copy)', { type: tab.type });
  }

  _closeOtherTabs(keepId) {
    const ids = [...this.tabs.keys()].filter(id => id !== keepId);
    for (const id of ids) this.closeTab(id);
  }

  // --- Terminal Theme Updates ---
  updateTerminalTheme(theme) {
    this._terminalTheme = theme;
    for (const [, tab] of this.tabs) {
      if (tab.type === 'terminal' && tab.term) {
        tab.term.options.theme = theme;
      }
    }
  }

  reopenLastTab() {
    const last = this.closedTabs.pop();
    if (!last) return;
    this.createTab(last.label + ' (reopened)');
  }

  // --- Feature 5: Terminal Font Zoom ---
  zoomFont(delta) {
    const tab = this.tabs.get(this.activeTabId);
    if (!tab || tab.type !== 'terminal' || !tab.term) return;
    const current = tab.term.options.fontSize || DEFAULT_FONT_SIZE;
    const next = Math.max(8, current + delta);
    tab.term.options.fontSize = next;
    tab.fitAddon.fit();
    window.nexus.resizeTerminal(this.activeTabId, tab.term.cols, tab.term.rows);
  }

  resetFontZoom() {
    const tab = this.tabs.get(this.activeTabId);
    if (!tab || tab.type !== 'terminal' || !tab.term) return;
    tab.term.options.fontSize = DEFAULT_FONT_SIZE;
    tab.fitAddon.fit();
    window.nexus.resizeTerminal(this.activeTabId, tab.term.cols, tab.term.rows);
  }

  // --- Session Recipes ---
  setRecipes(recipes) {
    this._recipes = recipes || [];
  }

  showQuickSwitcher() {
    // Remove existing
    const existing = document.querySelector('.quick-switcher');
    if (existing) { existing.remove(); return; }

    const overlay = document.createElement('div');
    overlay.className = 'quick-switcher';
    overlay.innerHTML = `
      <input type="text" class="qs-input" placeholder="Switch to tab..." spellcheck="false" />
      <div class="qs-results"></div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('.qs-input');
    const results = overlay.querySelector('.qs-results');
    let selectedIdx = 0;

    const render = (filter = '') => {
      const items = [...this.tabs.entries()]
        .map(([id, t]) => ({ id, label: t.label, type: t.type, status: t.tabEl?.querySelector('.tab-status')?.className || '' }))
        .filter(item => !filter || item.label.toLowerCase().includes(filter.toLowerCase()) || item.id.toLowerCase().includes(filter.toLowerCase()));

      selectedIdx = Math.min(selectedIdx, Math.max(0, items.length - 1));

      results.innerHTML = items.map((item, i) => {
        const active = item.id === this.activeTabId ? ' (active)' : '';
        const statusDot = item.type === 'terminal' ? '<span class="qs-status-dot"></span>' : '';
        return `<div class="qs-item${i === selectedIdx ? ' qs-selected' : ''}" data-id="${item.id}">${statusDot}<span class="qs-label">${item.label}${active}</span><span class="qs-id">${item.id}</span></div>`;
      }).join('');

      // Click handlers
      results.querySelectorAll('.qs-item').forEach(el => {
        el.addEventListener('click', () => {
          this.activateTab(el.dataset.id);
          overlay.remove();
        });
      });
    };

    input.addEventListener('input', () => { selectedIdx = 0; render(input.value); });
    input.addEventListener('keydown', (e) => {
      const items = results.querySelectorAll('.qs-item');
      if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = Math.min(selectedIdx + 1, items.length - 1); render(input.value); }
      if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = Math.max(selectedIdx - 1, 0); render(input.value); }
      if (e.key === 'Enter') { e.preventDefault(); const sel = items[selectedIdx]; if (sel) { this.activateTab(sel.dataset.id); overlay.remove(); } }
      if (e.key === 'Escape') { overlay.remove(); }
    });

    // Close on outside click
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });

    render();
    requestAnimationFrame(() => input.focus());
  }

  _spawnFromRecipe() {
    const recipes = this._recipes || [];
    if (recipes.length === 0) {
      alert('No recipes found. Place a .nexus-recipe.json file in your project root.');
      return;
    }
    this._showRecipeMenu(recipes);
  }

  _showRecipeMenu(recipes) {
    this._dismissContextMenu();
    const menu = document.createElement('div');
    menu.className = 'tab-context-menu recipe-menu';

    const header = document.createElement('div');
    header.className = 'ctx-header';
    header.textContent = 'Spawn from Recipe';
    menu.appendChild(header);

    for (const recipe of recipes) {
      const el = document.createElement('div');
      el.className = 'ctx-item';
      el.innerHTML = `<strong>${recipe.name}</strong><br><small>${recipe.description || ''}</small>`;
      el.addEventListener('click', () => {
        this._dismissContextMenu();
        this.createTab(recipe.name, {
          template: recipe.template,
          initialPrompt: recipe.prompt,
        });
      });
      menu.appendChild(el);
    }

    menu.style.left = `${Math.min(100, window.innerWidth - 220)}px`;
    menu.style.top = '40px';
    document.body.appendChild(menu);
    this._contextMenu = menu;
  }
}
