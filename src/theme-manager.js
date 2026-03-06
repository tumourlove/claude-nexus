export class ThemeManager {
  constructor() {
    this.themes = {
      corroboree: {
        '--bg-primary': '#1a1510',
        '--bg-secondary': '#2a2218',
        '--bg-tertiary': '#332b1e',
        '--bg-deep': '#120e08',
        '--text-primary': '#e8dcc8',
        '--text-secondary': '#8a9178',
        '--text-muted': '#5a5245',
        '--text-link': '#5a9e8f',
        '--accent': '#c17f3e',
        '--accent-hover': '#d4943a',
        '--accent-rgb': '193, 127, 62',
        '--border': '#3a3028',
        '--border-subtle': '#2a2218',
        '--tab-bg': '#1a1510',
        '--tab-hover-bg': '#332b1e',
        '--tab-active-color': '#c17f3e',
        '--scrollbar-thumb': '#c17f3e',
        '--toast-bg': '#2a2218',
        '--input-bg': '#1a1510',
        '--card-bg': '#1a1510',
        '--overlay-bg': 'rgba(18, 14, 8, 0.7)',
        '--kbd-bg': '#1a1510',
        '--kbd-border': '#3a3028',
        '--success': '#6b9e5a',
        '--warning': '#e6b422',
        '--error': '#c45a3c',
        '--info': '#5a9e8f',
      },
      dark: {
        '--bg-primary': '#1a1a2e',
        '--bg-secondary': '#16213e',
        '--bg-tertiary': '#0f3460',
        '--bg-deep': '#0a0f1e',
        '--text-primary': '#e0e0e0',
        '--text-secondary': '#8888aa',
        '--text-muted': '#555',
        '--text-link': '#4fc3f7',
        '--accent': '#e94560',
        '--accent-hover': '#d63452',
        '--accent-rgb': '233, 69, 96',
        '--border': '#0f3460',
        '--border-subtle': '#2a2a4e',
        '--tab-bg': '#1a1a2e',
        '--tab-hover-bg': '#0f3460',
        '--tab-active-color': '#e94560',
        '--scrollbar-thumb': '#e94560',
        '--toast-bg': '#16213e',
        '--input-bg': '#1a1a2e',
        '--card-bg': '#1a1a2e',
        '--overlay-bg': 'rgba(0, 0, 0, 0.6)',
        '--kbd-bg': '#1a1a2e',
        '--kbd-border': '#2a2a4e',
        '--success': '#66bb6a',
        '--warning': '#ffa726',
        '--error': '#ef5350',
        '--info': '#4fc3f7',
      },
      midnight: {
        '--bg-primary': '#0d1117',
        '--bg-secondary': '#161b22',
        '--bg-tertiary': '#21262d',
        '--bg-deep': '#010409',
        '--text-primary': '#e6edf3',
        '--text-secondary': '#8b949e',
        '--text-muted': '#484f58',
        '--text-link': '#58a6ff',
        '--accent': '#58a6ff',
        '--accent-hover': '#79c0ff',
        '--accent-rgb': '88, 166, 255',
        '--border': '#30363d',
        '--border-subtle': '#21262d',
        '--tab-bg': '#0d1117',
        '--tab-hover-bg': '#21262d',
        '--tab-active-color': '#58a6ff',
        '--scrollbar-thumb': '#58a6ff',
        '--toast-bg': '#161b22',
        '--input-bg': '#0d1117',
        '--card-bg': '#0d1117',
        '--overlay-bg': 'rgba(1, 4, 9, 0.7)',
        '--kbd-bg': '#0d1117',
        '--kbd-border': '#30363d',
        '--success': '#3fb950',
        '--warning': '#d29922',
        '--error': '#f85149',
        '--info': '#58a6ff',
      },
      light: {
        '--bg-primary': '#ffffff',
        '--bg-secondary': '#f6f8fa',
        '--bg-tertiary': '#e1e4e8',
        '--bg-deep': '#eef1f5',
        '--text-primary': '#1f2328',
        '--text-secondary': '#656d76',
        '--text-muted': '#8b949e',
        '--text-link': '#0969da',
        '--accent': '#0969da',
        '--accent-hover': '#0550ae',
        '--accent-rgb': '9, 105, 218',
        '--border': '#d0d7de',
        '--border-subtle': '#e1e4e8',
        '--tab-bg': '#ffffff',
        '--tab-hover-bg': '#e1e4e8',
        '--tab-active-color': '#0969da',
        '--scrollbar-thumb': '#0969da',
        '--toast-bg': '#ffffff',
        '--input-bg': '#ffffff',
        '--card-bg': '#ffffff',
        '--overlay-bg': 'rgba(0, 0, 0, 0.3)',
        '--kbd-bg': '#f6f8fa',
        '--kbd-border': '#d0d7de',
        '--success': '#1a7f37',
        '--warning': '#9a6700',
        '--error': '#cf222e',
        '--info': '#0969da',
      },
    };
    this.terminalThemes = {
      corroboree: {
        background: '#1a1510',
        foreground: '#e8dcc8',
        cursor: '#c17f3e',
        selectionBackground: '#c17f3e40',
      },
      dark: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#e94560',
        selectionBackground: '#e9456040',
      },
      midnight: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        selectionBackground: '#58a6ff40',
      },
      light: {
        background: '#ffffff',
        foreground: '#1f2328',
        cursor: '#0969da',
        selectionBackground: '#0969da40',
      },
    };
    this.themeOrder = ['corroboree', 'dark', 'midnight', 'light'];
    this.current = 'corroboree';
    this._changeCallbacks = [];
  }

  apply(themeName) {
    if (!this.themes[themeName]) return;
    this.current = themeName;
    const vars = this.themes[themeName];
    const root = document.documentElement;
    for (const [prop, value] of Object.entries(vars)) {
      root.style.setProperty(prop, value);
    }
    root.dataset.theme = themeName;
    this.save();
    for (const cb of this._changeCallbacks) {
      cb(themeName, this.terminalThemes[themeName]);
    }
  }

  cycle() {
    const idx = this.themeOrder.indexOf(this.current);
    const next = this.themeOrder[(idx + 1) % this.themeOrder.length];
    this.apply(next);
    return next;
  }

  onThemeChange(callback) {
    this._changeCallbacks.push(callback);
  }

  getTerminalTheme() {
    return this.terminalThemes[this.current] || this.terminalThemes.corroboree;
  }

  save() {
    localStorage.setItem('corroboree-theme', this.current);
  }

  load() {
    const saved = localStorage.getItem('corroboree-theme');
    if (saved && this.themes[saved]) {
      this.apply(saved);
    } else {
      this.apply('corroboree');
    }
  }
}
