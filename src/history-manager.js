const fs = require('fs');
const path = require('path');
const os = require('os');

class HistoryManager {
  constructor() {
    this.historyDir = path.join(os.homedir(), '.claude-nexus', 'history');
    fs.mkdirSync(this.historyDir, { recursive: true });
    this.buffers = new Map(); // sessionId -> string[]
    this.sessions = new Map(); // sessionId -> { output, startTime, label, template, isLead }
  }

  appendOutput(sessionId, data) {
    if (!this.buffers.has(sessionId)) {
      this.buffers.set(sessionId, []);
    }
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, { output: [], startTime: Date.now() });
    }
    this.sessions.get(sessionId).output.push(data);
    this.buffers.get(sessionId).push(data);

    // Keep buffer bounded (last 10000 lines worth)
    const buf = this.buffers.get(sessionId);
    if (buf.length > 10000) {
      this.buffers.set(sessionId, buf.slice(-5000));
    }
  }

  getRecentOutput(sessionId, lastNLines = 100) {
    const buf = this.buffers.get(sessionId) || [];
    const text = buf.join('');
    const lines = text.split('\n');
    return lines.slice(-lastNLines).join('\n');
  }

  searchAcrossSessions(pattern, sessionIds) {
    const regex = new RegExp(pattern, 'gi');
    const results = {};

    const targets = sessionIds || [...this.buffers.keys()];
    for (const id of targets) {
      const buf = this.buffers.get(id) || [];
      const text = buf.join('');
      const matches = [];
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (regex.test(line)) {
          matches.push({ line: i + 1, text: line.trim() });
        }
        regex.lastIndex = 0;
      });
      if (matches.length > 0) {
        results[id] = matches.slice(-50); // last 50 matches per session
      }
    }
    return results;
  }

  getRunSessions() {
    // Group sessions by lead session using spawn relationships
    // Returns array of { lead, workers: [], startTime, endTime }
    const sessions = [];
    for (const [id, data] of this.sessions) {
      sessions.push({
        id,
        label: data.label || id,
        template: data.template || 'unknown',
        startTime: data.startTime || Date.now(),
        output: data.output || [],
        isLead: data.isLead || false,
      });
    }

    // If we have leads, group workers under them
    const leads = sessions.filter(s => s.isLead);
    if (leads.length === 0 && sessions.length > 0) {
      // No lead — treat as a single run
      return [{ lead: sessions[0], workers: sessions.slice(1), startTime: sessions[0].startTime }];
    }

    return leads.map(lead => ({
      lead,
      workers: sessions.filter(s => !s.isLead),
      startTime: lead.startTime,
    }));
  }

  getTimestampedOutput(sessionId) {
    const data = this.sessions.get(sessionId);
    if (!data || !data.output) return [];
    return data.output.map((line, i) => ({
      line,
      timestamp: (data.startTime || Date.now()) + i * 100, // approximate
    }));
  }

  saveToFile(sessionId, label = '') {
    const buf = this.buffers.get(sessionId) || [];
    const filename = `${sessionId}-${Date.now()}${label ? '-' + label : ''}.log`;
    const filepath = path.join(this.historyDir, filename);
    fs.writeFileSync(filepath, buf.join(''));
    return filepath;
  }
}

module.exports = { HistoryManager };
