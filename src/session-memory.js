const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

class SessionMemory {
  constructor(dataDir) {
    this.dataDir = dataDir || path.join(os.homedir(), '.claude-corroboree', 'session-memory');
    this.memories = new Map(); // projectHash -> { entries: [], projectPath }
    this.load();
  }

  // Hash project path to a safe filename
  _projectHash(projectPath) {
    return crypto.createHash('md5').update(projectPath.replace(/\\/g, '/')).digest('hex').slice(0, 12);
  }

  _filePath(projectHash) {
    return path.join(this.dataDir, `${projectHash}.json`);
  }

  // Record a learning/discovery during a session
  addEntry(sessionId, { type, content, tags, projectPath }) {
    if (!projectPath) return null;
    // Truncate content to 500 chars
    const truncated = content && content.length > 500 ? content.slice(0, 500) : content;
    const hash = this._projectHash(projectPath);

    if (!this.memories.has(hash)) {
      this.memories.set(hash, { entries: [], projectPath });
    }

    const entry = {
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      type, // 'decision', 'discovery', 'failure', 'pattern', 'gotcha'
      content: truncated,
      tags: tags || [],
      timestamp: Date.now(),
    };

    this.memories.get(hash).entries.push(entry);
    this.prune();
    this.saveProject(hash);
    return entry.id;
  }

  // Get relevant memories for a new session starting a task
  getRelevant(projectPath, tags, limit = 10) {
    if (!projectPath) return [];
    const hash = this._projectHash(projectPath);
    const project = this.memories.get(hash);
    if (!project) return [];

    let entries = [...project.entries];

    if (tags && tags.length > 0) {
      // Score by tag match count + recency
      entries = entries.map(e => {
        const tagMatches = tags.filter(t => e.tags.includes(t)).length;
        const recencyScore = e.timestamp / Date.now(); // 0-1, higher = more recent
        return { ...e, score: tagMatches * 10 + recencyScore };
      });
      entries.sort((a, b) => b.score - a.score);
    } else {
      // Just sort by recency
      entries.sort((a, b) => b.timestamp - a.timestamp);
    }

    return entries.slice(0, limit).map(({ score, ...rest }) => rest);
  }

  // Get the lineage/history of a specific task across session resets
  getTaskLineage(taskDescription, projectPath) {
    if (!projectPath || !taskDescription) return [];
    const hash = this._projectHash(projectPath);
    const project = this.memories.get(hash);
    if (!project) return [];

    // Simple keyword matching: split task description into words, match against content
    const keywords = taskDescription.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3); // skip short words

    if (keywords.length === 0) return project.entries.slice(-20);

    const scored = project.entries.map(e => {
      const contentLower = e.content.toLowerCase();
      const tagsLower = e.tags.map(t => t.toLowerCase());
      let matches = 0;
      for (const kw of keywords) {
        if (contentLower.includes(kw)) matches++;
        if (tagsLower.some(t => t.includes(kw))) matches++;
      }
      return { ...e, matches };
    });

    return scored
      .filter(e => e.matches > 0)
      .sort((a, b) => b.matches - a.matches || b.timestamp - a.timestamp)
      .slice(0, 20)
      .map(({ matches, ...rest }) => rest);
  }

  // Persist a single project to disk
  saveProject(projectHash) {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const project = this.memories.get(projectHash);
      if (project) {
        fs.writeFileSync(this._filePath(projectHash), JSON.stringify(project, null, 2), 'utf8');
      }
    } catch (e) {
      // Silently fail — don't crash sessions over memory persistence
    }
  }

  // Load all projects from disk
  load() {
    try {
      if (!fs.existsSync(this.dataDir)) return;
      const files = fs.readdirSync(this.dataDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const hash = file.replace('.json', '');
        const data = JSON.parse(fs.readFileSync(path.join(this.dataDir, file), 'utf8'));
        this.memories.set(hash, data);
      }
    } catch (e) {
      // Start fresh if corrupt
    }
  }

  // Prune old entries (keep last maxPerProject per project)
  prune(maxPerProject = 500) {
    for (const [hash, project] of this.memories) {
      if (project.entries.length > maxPerProject) {
        project.entries = project.entries.slice(-maxPerProject);
      }
    }
  }
}

module.exports = { SessionMemory };
