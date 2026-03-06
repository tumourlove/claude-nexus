const fs = require('fs');
const path = require('path');

class KnowledgeBase {
  constructor(projectDir) {
    this.maxEntries = 500;
    this.entries = new Map(); // id -> entry
    this.nextId = 1;
    this.storePath = path.join(projectDir, '.claude-corroboree', 'knowledge.json');
    this._load();
  }

  add(entry) {
    const id = String(this.nextId++);
    this.entries.set(id, {
      id,
      category: entry.category || 'general', // architecture, pattern, gotcha, decision, api
      title: entry.title,
      content: entry.content,
      tags: entry.tags || [],
      createdBy: entry.createdBy || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    // Auto-prune oldest if over limit
    if (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) this.entries.delete(oldest.id);
    }
    this._save();
    return id;
  }

  search(query) {
    const lower = query.toLowerCase();
    const results = [];
    for (const entry of this.entries.values()) {
      const score = this._scoreMatch(entry, lower);
      if (score > 0) {
        results.push({ ...entry, score });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 20);
  }

  list(category) {
    let entries = [...this.entries.values()];
    if (category) {
      entries = entries.filter(e => e.category === category);
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    return entries;
  }

  get(id) {
    return this.entries.get(id) || null;
  }

  delete(id) {
    const deleted = this.entries.delete(id);
    if (deleted) this._save();
    return deleted;
  }

  _scoreMatch(entry, query) {
    let score = 0;
    if (entry.title.toLowerCase().includes(query)) score += 3;
    if (entry.content.toLowerCase().includes(query)) score += 1;
    if (entry.tags.some(t => t.toLowerCase().includes(query))) score += 2;
    if (entry.category.toLowerCase().includes(query)) score += 1;
    return score;
  }

  _load() {
    try {
      const dir = path.dirname(this.storePath);
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(this.storePath)) {
        const raw = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
        for (const entry of raw.entries || []) {
          this.entries.set(entry.id, entry);
          const numId = parseInt(entry.id, 10);
          if (numId >= this.nextId) this.nextId = numId + 1;
        }
      }
    } catch (e) {
      // Start fresh if file is corrupt
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.storePath);
      fs.mkdirSync(dir, { recursive: true });
      const data = { entries: [...this.entries.values()] };
      fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2));
    } catch (e) {
      // Ignore write errors
    }
  }

  destroy() {
    // No timers to clean up, just flush
    this._save();
  }
}

module.exports = { KnowledgeBase };
