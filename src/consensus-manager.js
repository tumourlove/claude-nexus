class ConsensusManager {
  constructor() {
    this.decisions = new Map();
    this.decisionCounter = 0;
  }

  proposeDecision(proposerId, { topic, options, description }) {
    const id = `decision-${Date.now()}-${++this.decisionCounter}`;
    const decision = {
      id,
      topic,
      options,
      description,
      proposer: proposerId,
      votes: {},
      status: 'open',
      resolvedOption: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.decisions.set(id, decision);
    return id;
  }

  vote(sessionId, decisionId, { choice, reasoning }) {
    const decision = this.decisions.get(decisionId);
    if (!decision) throw new Error(`Decision "${decisionId}" not found`);
    if (decision.status !== 'open') throw new Error(`Decision is already ${decision.status}`);
    if (!decision.options.includes(choice)) throw new Error(`Invalid choice "${choice}". Options: ${decision.options.join(', ')}`);
    decision.votes[sessionId] = { choice, reasoning, timestamp: Date.now() };
    decision.updatedAt = Date.now();
    return { ...decision };
  }

  resolveDecision(decisionId, winningOption) {
    const decision = this.decisions.get(decisionId);
    if (!decision) throw new Error(`Decision "${decisionId}" not found`);
    if (decision.status !== 'open') throw new Error(`Decision is already ${decision.status}`);

    if (winningOption) {
      if (!decision.options.includes(winningOption)) throw new Error(`Invalid option "${winningOption}"`);
      decision.resolvedOption = winningOption;
    } else {
      // Majority vote
      const tally = {};
      for (const opt of decision.options) tally[opt] = 0;
      for (const v of Object.values(decision.votes)) {
        tally[v.choice] = (tally[v.choice] || 0) + 1;
      }
      let maxCount = 0;
      let winner = decision.options[0];
      for (const [opt, count] of Object.entries(tally)) {
        if (count > maxCount) {
          maxCount = count;
          winner = opt;
        }
      }
      decision.resolvedOption = winner;
    }

    decision.status = 'resolved';
    decision.updatedAt = Date.now();
    return { ...decision };
  }

  getDecision(decisionId) {
    const decision = this.decisions.get(decisionId);
    if (!decision) return null;
    return { ...decision };
  }

  listDecisions(status) {
    const results = [];
    for (const decision of this.decisions.values()) {
      if (!status || decision.status === status) {
        results.push({ ...decision });
      }
    }
    return results;
  }
}

module.exports = { ConsensusManager };
