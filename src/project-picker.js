export class ProjectPicker {
  constructor(containerEl, onSelect) {
    this.container = containerEl;
    this.onSelect = onSelect;
    this.recentProjects = [];
    this._loadRecent();
    this._render();
  }

  _loadRecent() {
    try {
      const data = localStorage.getItem('nexus-recent-projects');
      if (data) this.recentProjects = JSON.parse(data);
    } catch (e) {
      this.recentProjects = [];
    }
  }

  _saveRecent() {
    localStorage.setItem('nexus-recent-projects', JSON.stringify(this.recentProjects.slice(0, 10)));
  }

  addRecent(projectPath) {
    this.recentProjects = this.recentProjects.filter(p => p !== projectPath);
    this.recentProjects.unshift(projectPath);
    this._saveRecent();
  }

  _render() {
    const recentHtml = this.recentProjects.length > 0
      ? this.recentProjects.map((p, i) => `
          <div class="picker-project" data-index="${i}">
            <span class="picker-project-icon">&#128193;</span>
            <div class="picker-project-info">
              <span class="picker-project-name">${this._projectName(p)}</span>
              <span class="picker-project-path">${p}</span>
            </div>
          </div>
        `).join('')
      : '<div class="picker-empty">No recent projects</div>';

    this.container.innerHTML = `
      <div class="picker-overlay">
        <div class="picker-dialog">
          <div class="picker-header">
            <h1>Claude Nexus</h1>
            <p>Select a project to open</p>
          </div>
          <div class="picker-actions">
            <button class="picker-browse" id="picker-browse">Browse...</button>
          </div>
          <div class="picker-recent">
            <h3>Recent Projects</h3>
            <div class="picker-list">
              ${recentHtml}
            </div>
          </div>
        </div>
      </div>
    `;

    // Event handlers
    this.container.querySelector('#picker-browse').addEventListener('click', () => {
      window.nexus.browseForFolder().then(result => {
        if (result) {
          this.addRecent(result);
          this._select(result);
        }
      });
    });

    this.container.querySelectorAll('.picker-project').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.index);
        this._select(this.recentProjects[idx]);
      });
    });
  }

  _select(projectPath) {
    this.addRecent(projectPath);
    this.container.innerHTML = '';
    this.container.style.display = 'none';
    if (this.onSelect) this.onSelect(projectPath);
  }

  _projectName(p) {
    const parts = p.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || parts[parts.length - 2] || p;
  }
}
