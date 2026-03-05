const fs = require('fs');
const path = require('path');

class KnowledgeGraph {
  constructor(projectDir) {
    this.entities = new Map(); // id -> entity
    this.relationships = new Map(); // id -> relationship
    this.entityCounter = 0;
    this.relCounter = 0;
    this.storePath = path.join(projectDir, '.claude-nexus', 'knowledge-graph.json');
    this._load();
  }

  addEntity(type, name, properties = {}, sessionId) {
    const id = `entity-${Date.now()}-${++this.entityCounter}`;
    const entity = {
      id,
      type, // file, function, concept, decision, pattern, bug
      name,
      properties,
      sessionId: sessionId || null,
      timestamp: Date.now(),
    };
    this.entities.set(id, entity);
    this._save();
    return id;
  }

  addRelationship(fromId, toId, relType, properties = {}, sessionId) {
    if (!this.entities.has(fromId)) return null;
    if (!this.entities.has(toId)) return null;
    const id = `rel-${Date.now()}-${++this.relCounter}`;
    const rel = {
      id,
      from: fromId,
      to: toId,
      type: relType, // depends-on, conflicts-with, implements, calls, related-to
      properties,
      sessionId: sessionId || null,
      timestamp: Date.now(),
    };
    this.relationships.set(id, rel);
    this._save();
    return id;
  }

  queryEntities({ type, namePattern, sessionId } = {}) {
    const results = [];
    for (const entity of this.entities.values()) {
      if (type && entity.type !== type) continue;
      if (namePattern && !entity.name.toLowerCase().includes(namePattern.toLowerCase())) continue;
      if (sessionId && entity.sessionId !== sessionId) continue;
      results.push(entity);
    }
    return results;
  }

  queryRelationships(entityId) {
    const incoming = [];
    const outgoing = [];
    for (const rel of this.relationships.values()) {
      if (rel.from === entityId) outgoing.push(rel);
      if (rel.to === entityId) incoming.push(rel);
    }
    return { incoming, outgoing };
  }

  traverse(entityId, maxDepth = 2) {
    if (!this.entities.has(entityId)) return { entities: [], relationships: [] };

    const visited = new Set();
    const foundEntities = [];
    const foundRels = [];
    const queue = [{ id: entityId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);

      const entity = this.entities.get(id);
      if (entity) foundEntities.push(entity);

      if (depth >= maxDepth) continue;

      for (const rel of this.relationships.values()) {
        if (rel.from === id && !visited.has(rel.to)) {
          foundRels.push(rel);
          queue.push({ id: rel.to, depth: depth + 1 });
        }
        if (rel.to === id && !visited.has(rel.from)) {
          foundRels.push(rel);
          queue.push({ id: rel.from, depth: depth + 1 });
        }
      }
    }

    return { entities: foundEntities, relationships: foundRels };
  }

  exportGraph() {
    return {
      entities: [...this.entities.values()],
      relationships: [...this.relationships.values()],
    };
  }

  _load() {
    try {
      const dir = path.dirname(this.storePath);
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(this.storePath)) {
        const raw = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
        for (const e of raw.entities || []) {
          this.entities.set(e.id, e);
          const num = parseInt(e.id.split('-').pop(), 10);
          if (num >= this.entityCounter) this.entityCounter = num;
        }
        for (const r of raw.relationships || []) {
          this.relationships.set(r.id, r);
          const num = parseInt(r.id.split('-').pop(), 10);
          if (num >= this.relCounter) this.relCounter = num;
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
      fs.writeFileSync(this.storePath, JSON.stringify(this.exportGraph(), null, 2));
    } catch (e) {
      // Ignore write errors
    }
  }

  destroy() {
    this._save();
  }
}

module.exports = { KnowledgeGraph };
