// CostTracker: parses Claude Code terminal output for token/cost data
// Best-effort — returns N/A if no data is parseable

export class CostTracker {
  constructor() {
    this.sessions = new Map(); // sessionId -> { inputTokens, outputTokens, totalCost, lastUpdate }
    this._aggregateCost = 0;
    this._startTime = Date.now();
    this._listeners = [];
  }

  // Parse a chunk of terminal output for cost/token patterns
  parseOutput(sessionId, data) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, { inputTokens: 0, outputTokens: 0, totalCost: 0, lastUpdate: null });
    }
    const session = this.sessions.get(sessionId);

    // Strip ANSI codes for clean matching
    const clean = data
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/\x1b[^[\]]/g, '');

    let changed = false;

    // Match dollar amounts like "$0.42" or "$1.23" — typically the total cost
    const costMatch = clean.match(/\$(\d+\.?\d*)/);
    if (costMatch) {
      const cost = parseFloat(costMatch[1]);
      if (!isNaN(cost) && cost > 0 && cost < 10000) {
        // Only update if it's larger (cost is cumulative)
        if (cost > session.totalCost) {
          const delta = cost - session.totalCost;
          session.totalCost = cost;
          this._aggregateCost += delta;
          session.lastUpdate = Date.now();
          changed = true;
        }
      }
    }

    // Match token counts like "12.3k tokens" or "1,234 tokens" or "input: 5.2k output: 3.1k"
    const tokenPatterns = [
      // "Xk input" / "Xk output" patterns
      /(\d+\.?\d*)k?\s*input\s*tok/i,
      /(\d+\.?\d*)k?\s*output\s*tok/i,
      // Generic "X tokens" or "Xk tokens"
      /(\d[\d,]*\.?\d*)k?\s+tokens?/i,
    ];

    const inputMatch = clean.match(/(\d+\.?\d*)k?\s*input/i);
    if (inputMatch) {
      const val = this._parseTokenCount(inputMatch[1], inputMatch[0].includes('k'));
      if (val > session.inputTokens) {
        session.inputTokens = val;
        changed = true;
      }
    }

    const outputMatch = clean.match(/(\d+\.?\d*)k?\s*output/i);
    if (outputMatch) {
      const val = this._parseTokenCount(outputMatch[1], outputMatch[0].includes('k'));
      if (val > session.outputTokens) {
        session.outputTokens = val;
        changed = true;
      }
    }

    if (changed) {
      this._notify();
    }
  }

  _parseTokenCount(str, hasK) {
    const num = parseFloat(str.replace(/,/g, ''));
    if (isNaN(num)) return 0;
    return hasK ? Math.round(num * 1000) : Math.round(num);
  }

  getSessionCost(sessionId) {
    return this.sessions.get(sessionId) || { inputTokens: 0, outputTokens: 0, totalCost: 0, lastUpdate: null };
  }

  getAggregate() {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;
    for (const s of this.sessions.values()) {
      totalInput += s.inputTokens;
      totalOutput += s.outputTokens;
      totalCost += s.totalCost;
    }
    const elapsedMinutes = (Date.now() - this._startTime) / 60000;
    const burnRate = elapsedMinutes > 0.5 ? totalCost / elapsedMinutes : 0;

    return {
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCost,
      burnRate, // cost per minute
      sessionCount: this.sessions.size,
    };
  }

  formatCost(cost) {
    if (cost === 0) return 'N/A';
    return `$${cost.toFixed(2)}`;
  }

  formatBurnRate(rate) {
    if (rate === 0) return '';
    return `$${rate.toFixed(2)}/min`;
  }

  onChange(callback) {
    this._listeners.push(callback);
  }

  _notify() {
    const agg = this.getAggregate();
    for (const cb of this._listeners) {
      try { cb(agg); } catch (e) { /* ignore listener errors */ }
    }
  }

  removeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      // Don't subtract from aggregate — cost already incurred
      this.sessions.delete(sessionId);
    }
  }
}
