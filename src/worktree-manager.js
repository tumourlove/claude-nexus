const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

class WorktreeManager {
  constructor() {
    this.worktrees = new Map(); // sessionId -> { path, branch }
  }

  createWorktree(sessionId, repoPath) {
    const branch = `nexus-${sessionId}-${Date.now()}`;
    const worktreePath = path.join(repoPath, '.nexus-worktrees', sessionId);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

    try {
      execSync(`git worktree add -b "${branch}" "${worktreePath}"`, {
        cwd: repoPath,
        stdio: 'pipe',
      });
    } catch (e) {
      throw new Error(`Failed to create worktree: ${e.message}`);
    }

    this.worktrees.set(sessionId, { path: worktreePath, branch, repoPath });
    return { path: worktreePath, branch };
  }

  removeWorktree(sessionId) {
    const wt = this.worktrees.get(sessionId);
    if (!wt) return;

    try {
      execSync(`git worktree remove "${wt.path}" --force`, {
        cwd: wt.repoPath,
        stdio: 'pipe',
      });
      execSync(`git branch -D "${wt.branch}"`, {
        cwd: wt.repoPath,
        stdio: 'pipe',
      });
    } catch (e) {
      // Best effort cleanup
    }

    this.worktrees.delete(sessionId);
  }

  getWorktree(sessionId) {
    return this.worktrees.get(sessionId);
  }

  cleanup() {
    for (const [id] of this.worktrees) {
      this.removeWorktree(id);
    }
  }
}

module.exports = { WorktreeManager };
